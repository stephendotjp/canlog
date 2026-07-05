// TEMPORARY one-off route to bulk-load the compiled canned-coffee data into the
// shared `products` cache. Guarded by a one-time token (only its SHA-256 is
// stored here, so this is safe to commit to a public repo). DELETE THIS ROUTE
// once the import has run — see handover §9 for the pattern.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import sql from "@/lib/db";
import products from "@/db/canned-coffee.import.json";

const TOKEN_SHA256 =
  "7b9be80c974319b9033e2c0a0d77bf8b4b6dcafb6b92327d925b9ff569de0dea";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") || "";
  const ok = createHash("sha256").update(token).digest("hex") === TOKEN_SHA256;
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let changed = 0;
  for (const p of products) {
    // Refresh our own prior bulk rows; never clobber a real user scan / higher confidence.
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

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*)::int AS count FROM products
  `;
  return NextResponse.json({ attempted: products.length, changed, total_products: count });
}
