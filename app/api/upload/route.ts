import { NextResponse } from "next/server";
import { put } from "@vercel/blob";

// Stores a scanned photo in Vercel Blob and returns its public URL, which the
// client then attaches to the entry on save. If no Blob token is configured
// (e.g. local dev), we return { url: null } so logging still works without a
// stored image.
export async function POST(req: Request) {
  try {
    const { imageBase64, mediaType } = await req.json();
    if (!imageBase64) {
      return NextResponse.json({ error: "imageBase64 is required" }, { status: 400 });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return NextResponse.json({ url: null });
    }
    const buffer = Buffer.from(imageBase64, "base64");
    const ext = (mediaType || "image/jpeg").split("/")[1] || "jpg";
    const blob = await put(`scans/${crypto.randomUUID()}.${ext}`, buffer, {
      access: "public",
      contentType: mediaType || "image/jpeg",
    });
    return NextResponse.json({ url: blob.url });
  } catch (err) {
    console.error("image upload failed", err);
    // Non-fatal: the entry can still be logged without a thumbnail.
    return NextResponse.json({ url: null }, { status: 200 });
  }
}
