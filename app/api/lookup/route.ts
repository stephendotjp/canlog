import { NextResponse } from "next/server";
import { lookupNameByJan } from "@/lib/anthropic";

// Optional, user-triggered JAN -> product-name lookup via server-side web search.
// Never called automatically — the client only hits this when the user taps
// "look up name online", keeping AI/API costs predictable.
export async function POST(req: Request) {
  try {
    const { jan } = await req.json();
    if (!jan) {
      return NextResponse.json({ error: "jan is required" }, { status: 400 });
    }
    const result = await lookupNameByJan(String(jan));
    return NextResponse.json(result);
  } catch (err) {
    console.error("jan lookup failed", err);
    return NextResponse.json(
      { name: null, brand: null, found: false, source_note: "lookup failed" },
      { status: 200 }
    );
  }
}
