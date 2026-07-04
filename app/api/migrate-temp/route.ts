import { NextResponse } from "next/server";
import sql from "@/lib/db";

// TEMPORARY one-time migration route. Adds the entries.temperature column for the
// Hot/Cold feature. Token-guarded, idempotent (ADD COLUMN IF NOT EXISTS), and
// non-destructive. DELETE this route once the migration has been run in prod.
const TOKEN = "canlog-migrate-8f3a2c9e51";

export async function GET(req: Request) {
  const url = new URL(req.url);
  if (url.searchParams.get("token") !== TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    await sql`ALTER TABLE entries ADD COLUMN IF NOT EXISTS temperature TEXT`;
    return NextResponse.json({ ok: true, migrated: "entries.temperature" });
  } catch (err) {
    console.error("migrate-temp failed", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
