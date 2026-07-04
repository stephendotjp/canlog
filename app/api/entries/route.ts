import { NextResponse } from "next/server";
import sql from "@/lib/db";
import type { Entry } from "@/lib/types";

function deviceId(req: Request): string | null {
  const id = req.headers.get("x-device-id");
  return id && id.trim() ? id.trim() : null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// GET /api/entries — the caller's own log, newest first.
export async function GET(req: Request) {
  const user = deviceId(req);
  if (!user) return NextResponse.json({ entries: [] });
  try {
    const rows = await sql<Entry[]>`
      SELECT id, jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
             sodium_mg, caffeine_mg, caffeine_is_estimate, price_yen, image_url,
             "timestamp"
      FROM entries
      WHERE user_id = ${user}
      ORDER BY "timestamp" DESC
    `;
    return NextResponse.json({ entries: rows });
  } catch (err) {
    console.error("list entries failed", err);
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
}

// POST /api/entries — log a drink using the USER-CONFIRMED values.
//
// This is also the ONLY place a product gets written to the shared cache, and it
// uses the corrected values (real name, scaled nutrition) — never the raw first
// AI pass. That's the fix for the "generic name baked into the cache" bug: we
// don't cache on the Stage 2 read, we cache here on confirm.
export async function POST(req: Request) {
  const user = deviceId(req);
  if (!user) return NextResponse.json({ error: "missing device id" }, { status: 400 });

  try {
    const d = await req.json();
    const jan: string | null = d.jan ? String(d.jan) : null;

    const entry = {
      brand: d.brand || "Unknown",
      name: d.name || "Coffee",
      size_ml: num(d.size_ml),
      calories: num(d.calories),
      carbs_g: num(d.carbs_g),
      protein_g: num(d.protein_g),
      fat_g: num(d.fat_g),
      sodium_mg: num(d.sodium_mg),
      caffeine_mg: num(d.caffeine_mg),
      caffeine_is_estimate: !!d.caffeine_is_estimate,
      price_yen: num(d.price_yen),
      image_url: d.image_url || null,
      confidence: d.confidence || "manual",
    };

    const [row] = await sql<Entry[]>`
      INSERT INTO entries (
        user_id, jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
        sodium_mg, caffeine_mg, caffeine_is_estimate, price_yen, image_url
      ) VALUES (
        ${user}, ${jan}, ${entry.brand}, ${entry.name}, ${entry.size_ml},
        ${entry.calories}, ${entry.carbs_g}, ${entry.protein_g}, ${entry.fat_g},
        ${entry.sodium_mg}, ${entry.caffeine_mg}, ${entry.caffeine_is_estimate},
        ${entry.price_yen}, ${entry.image_url}
      )
      RETURNING id, jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
                sodium_mg, caffeine_mg, caffeine_is_estimate, price_yen, image_url,
                "timestamp"
    `;

    // Upsert the shared product cache using the confirmed values. price_yen and
    // image_url are deliberately NOT part of the product record.
    if (jan) {
      await sql`
        INSERT INTO products (
          jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
          sodium_mg, caffeine_mg, caffeine_is_estimate, confidence, updated_at
        ) VALUES (
          ${jan}, ${entry.brand}, ${entry.name}, ${entry.size_ml},
          ${entry.calories}, ${entry.carbs_g}, ${entry.protein_g}, ${entry.fat_g},
          ${entry.sodium_mg}, ${entry.caffeine_mg}, ${entry.caffeine_is_estimate},
          ${entry.confidence}, now()
        )
        ON CONFLICT (jan) DO UPDATE SET
          brand = EXCLUDED.brand,
          name = EXCLUDED.name,
          size_ml = EXCLUDED.size_ml,
          calories = EXCLUDED.calories,
          carbs_g = EXCLUDED.carbs_g,
          protein_g = EXCLUDED.protein_g,
          fat_g = EXCLUDED.fat_g,
          sodium_mg = EXCLUDED.sodium_mg,
          caffeine_mg = EXCLUDED.caffeine_mg,
          caffeine_is_estimate = EXCLUDED.caffeine_is_estimate,
          confidence = EXCLUDED.confidence,
          updated_at = now()
      `;
    }

    return NextResponse.json({ entry: row });
  } catch (err) {
    console.error("create entry failed", err);
    return NextResponse.json({ error: "create_failed" }, { status: 500 });
  }
}
