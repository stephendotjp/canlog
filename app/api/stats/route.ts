import { NextResponse } from "next/server";
import sql from "@/lib/db";

// TEMPORARY read-only inspection endpoint, token-guarded. Confirms the DB is
// persisting the shared product cache and per-device logs. Removed after use.
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!process.env.STATS_TOKEN || token !== process.env.STATS_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const products = await sql`
      SELECT jan, brand, name, size_ml, calories, caffeine_mg, updated_at
      FROM products ORDER BY updated_at DESC LIMIT 50
    `;
    const [{ pc }] = await sql<{ pc: number }[]>`SELECT count(*)::int pc FROM products`;
    const [{ ec }] = await sql<{ ec: number }[]>`SELECT count(*)::int ec FROM entries`;
    const [{ dc }] =
      await sql<{ dc: number }[]>`SELECT count(DISTINCT user_id)::int dc FROM entries`;
    return NextResponse.json({
      productCount: pc,
      entryCount: ec,
      distinctDevices: dc,
      products,
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
