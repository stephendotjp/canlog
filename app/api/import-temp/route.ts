// TEMPORARY one-off route to bulk-load the compiled canned-coffee data into the
// shared `products` cache. Guarded by a one-time token (only its SHA-256 is
// stored here, so this is safe to commit to a public repo). DELETE THIS ROUTE
// once the import has run — see handover §9 for the pattern.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import sql from "@/lib/db";
import products from "@/db/canned-coffee.import.json";

const TOKEN_SHA256 =
  "bcedeea615894f8465920849909bfd401daf956f6cf839488e8718890f78a598";

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token") || "";
  const ok =
    createHash("sha256").update(token).digest("hex") === TOKEN_SHA256;
  if (!ok) return NextResponse.json({ error: "forbidden" }, { status: 403 });

  let inserted = 0;
  for (const p of products) {
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

  const [{ count }] = await sql<{ count: string }[]>`
    SELECT count(*)::int AS count FROM products
  `;
  return NextResponse.json({ attempted: products.length, inserted, total_products: count });
}
