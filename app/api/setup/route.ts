import { NextResponse } from "next/server";
import sql from "@/lib/db";
import { SCHEMA_SQL } from "@/lib/schema";

// TEMPORARY one-time bootstrap: creates the tables from inside the deployment,
// where the (redacted-on-pull) DB credentials are available at runtime. Guarded
// by SETUP_TOKEN. This route is removed once migration has run.
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("token");
  if (!process.env.SETUP_TOKEN || token !== process.env.SETUP_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await sql.unsafe(SCHEMA_SQL).simple();
    const [{ count }] = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM products
    `;
    return NextResponse.json({ ok: true, tables: "created", products: count });
  } catch (e) {
    console.error("setup failed", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
