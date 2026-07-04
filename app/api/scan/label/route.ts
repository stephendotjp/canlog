import { NextResponse } from "next/server";
import { extractLabelData, normalizeMediaType } from "@/lib/anthropic";

// Stage 2 — full nutrition-label read. Only runs on a cache miss (or a forced
// rescan / unreadable barcode). The per-100g scaling and salt->sodium conversion
// are performed inside the extraction prompt; this route just returns the draft.
export async function POST(req: Request) {
  try {
    const { imageBase64, mediaType } = await req.json();
    if (!imageBase64) {
      return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 });
    }
    const result = await extractLabelData(imageBase64, normalizeMediaType(mediaType));
    return NextResponse.json(result);
  } catch (err) {
    console.error("label scan failed", err);
    return NextResponse.json({ error: "extraction_failed" }, { status: 502 });
  }
}
