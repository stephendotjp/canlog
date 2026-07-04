import { NextResponse } from "next/server";
import sql from "@/lib/db";

function deviceId(req: Request): string | null {
  const id = req.headers.get("x-device-id");
  return id && id.trim() ? id.trim() : null;
}

// DELETE /api/entries/:id — only the owning device can delete its own entry.
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = deviceId(req);
  if (!user) return NextResponse.json({ error: "missing device id" }, { status: 400 });
  const { id } = await ctx.params;
  try {
    await sql`DELETE FROM entries WHERE id = ${id} AND user_id = ${user}`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("delete entry failed", err);
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }
}
