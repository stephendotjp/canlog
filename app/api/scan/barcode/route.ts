import { NextResponse } from "next/server";
import { extractBarcode, normalizeMediaType } from "@/lib/anthropic";

// Stage 1 — cheap barcode read. Runs on every scan.
export async function POST(req: Request) {
  try {
    const { imageBase64, mediaType } = await req.json();
    if (!imageBase64) {
      return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 });
    }
    const result = await extractBarcode(imageBase64, normalizeMediaType(mediaType));
    return NextResponse.json(result);
  } catch (err) {
    console.error("barcode scan failed", err);
    return NextResponse.json({ jan: null, readable: false }, { status: 200 });
  }
}
