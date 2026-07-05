// One-off importer for canned_coffee_japan_db.csv -> shared `products` cache.
//
// The CSV (re-parsed from source scraps.hamanegi.com/cancoffeebook via items_raw.json)
// resolves every row to a known nutrition basis and provides normalized per-100g
// columns. CanLog stores PER-CONTAINER TOTALS, so we scale every value up by the
// can volume: per_container = per_100g * (volume / 100).
//
// Conventions match lib/anthropic.ts + the entries route:
//   * all stored values are PER-CONTAINER TOTALS
//   * sodium_mg = salt_g * 1000 / 2.54   (salt scaled to per-container first)
//   * caffeine stored AS LABELED (not scaled): on cans the caffeine figure is a
//     per-container "1本あたり" number even when the panel is per-100g. Absent -> NULL
//     (the app estimates it).
//   * confidence = "medium" (compiled data, not user-verified)
//   * ON CONFLICT (jan) DO UPDATE ... WHERE confidence = 'medium' — refreshes our own
//     prior bulk rows but NEVER clobbers a real user scan or higher-confidence data.
//
// Usage:
//   npx tsx db/import-canned-coffee.ts            # dry run: report + JSON, no DB
//   npx tsx db/import-canned-coffee.ts --commit   # upsert into the DB (needs creds)

import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { loadEnv } from "./loadEnv";

const CSV_PATH = "canned_coffee_japan_db.csv";
const OUT_JSON = "db/canned-coffee.import.json";

interface Product {
  jan: string;
  brand: string;
  name: string;
  size_ml: number | null;
  calories: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number | null;
  caffeine_is_estimate: boolean;
  confidence: "medium";
}

// --- CSV parsing (handles quoted fields with embedded commas/newlines) --------
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* ignore */ }
    else if (c === "\n") { row.push(field); rows.push(row); field = ""; row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Single number, or a range "0-1.4" -> midpoint. Strips stray non-numeric chars.
function toNumber(raw: string): number | null {
  const v = (raw || "").trim();
  if (!v) return null;
  const parts = v.split("-").map((p) => p.replace(/[^0-9.]/g, "")).filter((p) => p !== "" && p !== ".");
  if (!parts.length) return null;
  const nums = parts.map(Number).filter((n) => !Number.isNaN(n));
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

const toSizeMl = (raw: string): number | null => {
  const m = (raw || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
};
const round = (n: number | null, dp: number): number | null =>
  n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;

function main() {
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const c = (name: string) => {
    const i = header.indexOf(name);
    if (i === -1) throw new Error(`missing column: ${name}`);
    return i;
  };
  const idx = {
    brand: c("Brand"),
    name: c("Product Name (Japanese)"),
    jan: c("JAN Code"),
    volume: c("Volume"),
    basis: c("Basis Type"),
    energy: c("Energy per 100g (kcal)"),
    protein: c("Protein per 100g (g)"),
    fat: c("Fat per 100g (g)"),
    carb: c("Carbohydrate per 100g (g)"),
    salt: c("Salt per 100g (g)"),
    caffeine: c("Caffeine as labeled (mg)"),
  };

  const loaded: Product[] = [];
  const seen = new Set<string>();
  const badJans: string[] = [];
  const skipped = { badJan: 0, dupe: 0, noVolume: 0 };

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.length < header.length) continue;
    // Strip stray non-digits (trailing mojibake bytes etc.). A clean JAN is 13
    // digits; anything else (e.g. the 14-digit source typo) is flagged, not guessed.
    const rawJan = (cells[idx.jan] || "").trim();
    const jan = rawJan.replace(/\D/g, "");
    if (jan.length !== 13) { skipped.badJan++; badJans.push(rawJan); continue; }
    if (seen.has(jan)) { skipped.dupe++; continue; }

    const size = toSizeMl(cells[idx.volume]);
    if (!size) { skipped.noVolume++; continue; }
    const s = size / 100; // per-100g -> per-container multiplier

    const salt = toNumber(cells[idx.salt]);
    const caffeine = toNumber(cells[idx.caffeine]);
    const scale = (col: number) => {
      const n = toNumber(cells[col]);
      return n == null ? null : n * s;
    };

    seen.add(jan);
    loaded.push({
      jan,
      brand: (cells[idx.brand] || "").trim(),
      name: (cells[idx.name] || "").trim().replace(/\s+/g, " "),
      size_ml: size,
      calories: round(scale(idx.energy), 0),
      carbs_g: round(scale(idx.carb), 1),
      protein_g: round(scale(idx.protein), 1),
      fat_g: round(scale(idx.fat), 1),
      sodium_mg: round(salt == null ? null : salt * s * 1000 / 2.54, 0),
      caffeine_mg: caffeine, // as labeled, not scaled
      caffeine_is_estimate: caffeine == null,
      confidence: "medium",
    });
  }

  writeFileSync(OUT_JSON, JSON.stringify(loaded, null, 2), "utf8");

  const byBasis = new Map<string, number>();
  for (let r = 1; r < rows.length; r++) {
    const b = (rows[r][idx.basis] || "?").trim();
    byBasis.set(b, (byBasis.get(b) || 0) + 1);
  }
  console.log(`\n=== canned-coffee import ===`);
  console.log(`Loading:  ${loaded.length} rows  (basis in source: ${[...byBasis].map(([k, v]) => `${v} ${k}`).join(", ")})`);
  console.log(`Skipped:  ${skipped.dupe} dup JAN, ${skipped.badJan} bad JAN, ${skipped.noVolume} no volume`);
  if (badJans.length) console.log(`  bad JANs (need real barcode from can): ${badJans.map((j) => JSON.stringify(j)).join(", ")}`);
  console.log(`Wrote -> ${OUT_JSON}`);

  console.log(`\nSpot-checks (per-container):`);
  const show = (jan: string, label: string) => {
    const p = loaded.find((x) => x.jan === jan);
    console.log(p
      ? `  ${label}: ${p.size_ml}ml  ${p.calories}kcal  carb ${p.carbs_g}g  Na ${p.sodium_mg}mg  caf ${p.caffeine_mg ?? "—"}`
      : `  ${label}: (not found)`);
  };
  show("4901777344006", "BOSS Rainbow Bitter (per-100g)");
  show("4901777394148", "BOSS Caffeine200 (per-container)");
  show("4902102139311", "Georgia Kaoru Black (per-100ml)");
  show("4904910239801", "DyDo Blend Original (was held)");

  return { loaded, commit: process.argv.includes("--commit") };
}

async function commit(loaded: Product[]) {
  loadEnv();
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set (needed for --commit).");
  const sql = postgres(url, { prepare: false });
  let changed = 0;
  for (const p of loaded) {
    const res = await sql`
      INSERT INTO products (
        jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
        sodium_mg, caffeine_mg, caffeine_is_estimate, confidence, updated_at
      ) VALUES (
        ${p.jan}, ${p.brand}, ${p.name}, ${p.size_ml}, ${p.calories}, ${p.carbs_g},
        ${p.protein_g}, ${p.fat_g}, ${p.sodium_mg}, ${p.caffeine_mg},
        ${p.caffeine_is_estimate}, ${p.confidence}, now()
      )
      ON CONFLICT (jan) DO UPDATE SET
        brand = EXCLUDED.brand, name = EXCLUDED.name, size_ml = EXCLUDED.size_ml,
        calories = EXCLUDED.calories, carbs_g = EXCLUDED.carbs_g,
        protein_g = EXCLUDED.protein_g, fat_g = EXCLUDED.fat_g,
        sodium_mg = EXCLUDED.sodium_mg, caffeine_mg = EXCLUDED.caffeine_mg,
        caffeine_is_estimate = EXCLUDED.caffeine_is_estimate,
        confidence = EXCLUDED.confidence, updated_at = now()
      WHERE products.confidence = 'medium'
    `;
    changed += res.count;
  }
  console.log(`\n✓ inserted/updated ${changed} bulk row(s) (user/high-confidence rows untouched)`);
  await sql.end();
}

const { loaded, commit: doCommit } = main();
if (doCommit) commit(loaded).catch((e) => { console.error(e); process.exit(1); });
else console.log(`\n(dry run — no DB writes. Re-run with --commit to load.)`);
