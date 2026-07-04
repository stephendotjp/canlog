// One-off importer for canned_coffee_japan_db.csv -> shared `products` cache.
//
// The CSV mixes two nutrition bases and the "Nutrition Basis" column is only
// partially filled, so this importer loads ONLY the rows whose per-container
// numbers are unambiguous:
//
//   1. Rows explicitly labeled "100g"      -> scale every value by size/100.
//   2. Blank-basis rows that are black/near-zero coffee (energy < 8, no milk
//      macros) -> basis is irrelevant (0 either way), store as-is.
//
// The ~124 blank-basis MILK rows are deliberately SKIPPED: their real basis is
// per-100g for most brands but per-container for BOSS, and guessing on a shared
// cache would poison it. They stay parked until the basis is confirmed.
//
// Conventions match lib/anthropic.ts + the entries route:
//   * all stored values are PER-CONTAINER TOTALS
//   * sodium_mg = salt_g * 1000 / 2.54
//   * caffeine left NULL when the label omits it (the app estimates it)
//   * confidence = "medium" (compiled data, not user-verified)
//   * ON CONFLICT (jan) DO NOTHING — never clobbers a real user scan.
//
// Usage:
//   npx tsx db/import-canned-coffee.ts            # dry run: report + JSON, no DB
//   npx tsx db/import-canned-coffee.ts --commit   # upsert into the DB

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
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\r") { /* ignore */ }
    else if (c === "\n") { row.push(field); rows.push(row); field = ""; row = []; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// A value may be a single number, a range "0-1.4", or noise like "約60"/"00.8".
// Collapse ranges to their midpoint; strip non-numeric characters otherwise.
function toNumber(raw: string): number | null {
  const v = (raw || "").trim();
  if (!v) return null;
  const parts = v.split("-").map((p) => p.replace(/[^0-9.]/g, "")).filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return null;
  const nums = parts.map(Number).filter((n) => !Number.isNaN(n));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function toSizeMl(raw: string): number | null {
  const m = (raw || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

const round = (n: number | null, dp: number): number | null =>
  n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp;

function main() {
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const header = rows[0].map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const idx = {
    brand: col("Brand"),
    name: col("Product Name (Japanese)"),
    jan: col("JAN Code"),
    volume: col("Volume"),
    basis: col("Nutrition Basis"),
    energy: col("Energy (kcal)"),
    protein: col("Protein (g)"),
    fat: col("Fat (g)"),
    carb: col("Carbohydrate (g)"),
    salt: col("Salt Equivalent (g)"),
    caffeine: col("Caffeine (mg)"),
  };

  const loaded: Product[] = [];
  const seenJan = new Set<string>();
  const skipped = { ambiguous: 0, dupe: 0, badJan: 0 };

  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells || cells.length < header.length) continue;
    const jan = (cells[idx.jan] || "").trim();
    if (!/^\d{13}$/.test(jan)) { skipped.badJan++; continue; }

    const basis = (cells[idx.basis] || "").trim();
    const size = toSizeMl(cells[idx.volume]);
    const energy = toNumber(cells[idx.energy]);
    const protein = toNumber(cells[idx.protein]);
    const fat = toNumber(cells[idx.fat]);
    const carb = toNumber(cells[idx.carb]);
    const salt = toNumber(cells[idx.salt]);
    const caffeine = toNumber(cells[idx.caffeine]);

    const isBlack =
      (energy ?? 0) < 8 && (fat ?? 0) < 1 && (protein ?? 0) < 1 && (carb ?? 0) < 2;

    let scale: number; // multiplier to reach per-container totals
    if (basis === "100g") {
      if (!size) { skipped.ambiguous++; continue; }
      scale = size / 100;
    } else if (isBlack) {
      scale = 1; // near-zero: basis irrelevant
    } else {
      skipped.ambiguous++; // blank-basis milk row — hold it
      continue;
    }

    if (seenJan.has(jan)) { skipped.dupe++; continue; }
    seenJan.add(jan);

    const sodium = salt == null ? null : (salt * scale) * 1000 / 2.54;

    loaded.push({
      jan,
      brand: (cells[idx.brand] || "").trim(),
      name: (cells[idx.name] || "").trim().replace(/\s+/g, " "),
      size_ml: size,
      calories: round(energy == null ? null : energy * scale, 0),
      carbs_g: round(carb == null ? null : carb * scale, 1),
      protein_g: round(protein == null ? null : protein * scale, 1),
      fat_g: round(fat == null ? null : fat * scale, 1),
      sodium_mg: round(sodium, 0),
      // Caffeine is stored as-is (not scaled): the CSV's caffeine figures read as
      // per-container even on 100g-basis rows. Present -> trusted; absent -> app estimates.
      caffeine_mg: caffeine,
      caffeine_is_estimate: caffeine == null,
      confidence: "medium",
    });
  }

  writeFileSync(OUT_JSON, JSON.stringify(loaded, null, 2), "utf8");

  console.log(`\n=== canned-coffee import ===`);
  console.log(`Loading:  ${loaded.length} rows`);
  console.log(`Skipped:  ${skipped.ambiguous} ambiguous milk (held), ${skipped.dupe} duplicate JAN, ${skipped.badJan} bad JAN`);
  console.log(`Wrote normalized rows -> ${OUT_JSON}`);

  console.log(`\nSpot-checks (verify against a real can):`);
  const show = (jan: string, label: string) => {
    const p = loaded.find((x) => x.jan === jan);
    if (p) console.log(`  ${label}: ${p.size_ml}ml  ${p.calories}kcal  carb ${p.carbs_g}g  Na ${p.sodium_mg}mg  caf ${p.caffeine_mg ?? "—"}`);
    else console.log(`  ${label}: (held / not loaded)`);
  };
  show("4901777344006", "BOSS Rainbow Mtn Bitter (100g basis, 185g)");
  show("4901777204980", "BOSS Black (100g basis, 185g)");
  show("4902102147323", "Georgia Black (black, blank basis)");
  show("4901201144561", "UCC Black Rich (black, no kcal)");

  return { loaded, commit: process.argv.includes("--commit") };
}

async function commit(loaded: Product[]) {
  loadEnv();
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set (needed for --commit).");
  const sql = postgres(url, { prepare: false });
  let inserted = 0;
  for (const p of loaded) {
    const res = await sql`
      INSERT INTO products (
        jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
        sodium_mg, caffeine_mg, caffeine_is_estimate, confidence
      ) VALUES (
        ${p.jan}, ${p.brand}, ${p.name}, ${p.size_ml}, ${p.calories}, ${p.carbs_g},
        ${p.protein_g}, ${p.fat_g}, ${p.sodium_mg}, ${p.caffeine_mg},
        ${p.caffeine_is_estimate}, ${p.confidence}
      )
      ON CONFLICT (jan) DO NOTHING
    `;
    inserted += res.count;
  }
  console.log(`\n✓ inserted ${inserted} new product(s) (existing JANs left untouched)`);
  await sql.end();
}

const { loaded, commit: doCommit } = main();
if (doCommit) commit(loaded).catch((e) => { console.error(e); process.exit(1); });
else console.log(`\n(dry run — no DB writes. Re-run with --commit to load.)`);
