import { NextResponse } from "next/server";
import sql from "@/lib/db";
import type { Product } from "@/lib/types";

// Cache check. A hit lets the client skip the expensive Stage 2 label read.
export async function GET(_req: Request, ctx: { params: Promise<{ jan: string }> }) {
  const { jan } = await ctx.params;
  try {
    const rows = await sql<Product[]>`
      SELECT jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
             sodium_mg, caffeine_mg, caffeine_is_estimate, confidence
      FROM products
      WHERE jan = ${jan}
      LIMIT 1
    `;
    if (rows.length === 0) {
      return NextResponse.json({ hit: false }, { status: 404 });
    }
    return NextResponse.json({ hit: true, product: rows[0] });
  } catch (err) {
    console.error("product lookup failed", err);
    return NextResponse.json({ hit: false }, { status: 500 });
  }
}
