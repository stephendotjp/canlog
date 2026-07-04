import Anthropic from "@anthropic-ai/sdk";
import type { BarcodeResult, LabelResult, LookupResult } from "./types";

// Called ONLY from server-side API routes. The key never reaches the client.
const anthropic = new Anthropic();

// Per the rebuild spec. Sonnet keeps per-scan cost low on a vision-heavy app.
// To use a stronger model, change this to "claude-opus-4-8".
const MODEL = "claude-sonnet-4-6";

function parseJson<T>(text: string): T {
  const raw = text.replace(/```json|```/g, "").trim();
  return JSON.parse(raw) as T;
}

type MediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

async function callClaudeVision<T>(
  base64: string,
  mediaType: MediaType,
  prompt: string,
  maxTokens = 500
): Promise<T> {
  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseJson<T>(text);
}

// Stage 1: cheap, narrow call — just try to read the JAN/EAN barcode digits.
// This is the call that runs on every scan, so it's kept small on purpose.
export async function extractBarcode(base64: string, mediaType: MediaType): Promise<BarcodeResult> {
  const prompt = `Look at this photo of the back of a drink can/bottle. Find the barcode (JAN/EAN-13, usually 13 digits, printed as lines with digits underneath).

Respond with ONLY raw JSON, no markdown fences:
{"jan": string|null, "readable": boolean}

If you cannot clearly read all the digits, set "jan" to null and "readable" to false. Do not guess digits you can't actually see.`;
  return callClaudeVision<BarcodeResult>(base64, mediaType, prompt, 200);
}

// Stage 2: fuller call — only runs on a cache miss. Reads the nutrition facts panel.
export async function extractLabelData(base64: string, mediaType: MediaType): Promise<LabelResult> {
  const prompt = `Look at this photo of the back of a Japanese drink can/bottle label. Read the printed nutrition facts panel (栄養成分表示) and any visible brand name.

Respond with ONLY raw JSON, no markdown fences, in exactly this shape:
{"brand": string, "name": string, "name_is_generic": boolean, "size_ml": number, "calories": number, "carbs_g": number, "protein_g": number, "fat_g": number, "sodium_mg": number, "caffeine_mg": number, "caffeine_is_estimate": boolean, "confidence": "high"|"medium"|"low", "notes": string}

Critical rules — read carefully, these are common mistakes:

1. PER-CONTAINER SCALING: Japanese nutrition panels are very often printed "per 100g" or "per 100ml" (製品100gあたり / 100mlあたり), NOT per whole container. Check which one it says. If it's per-100g/ml, you MUST multiply every value by (container_size / 100) to get the true per-container totals before outputting them. Example: if the label says "100gあたり エネルギー30kcal" and the can is 185g, the real answer for "calories" is 30 × 1.85 = 55.5, not 30. Only skip this scaling if the label explicitly says it's already per-container (1本あたり / 製品1本).

2. SALT-TO-SODIUM CONVERSION: Japanese labels print 食塩相当量 (salt equivalent) in grams, not sodium directly. Convert using: sodium_mg = salt_g × 1000 ÷ 2.54. Do this BEFORE the per-container scaling in step 1, or apply the scaling to the grams first then convert — either order, just don't skip the conversion. Never put the raw salt-gram number into sodium_mg unconverted.

3. PRODUCT NAME: the "名称" field on Japanese labels is a legal food-category label (e.g. "コーヒー", "乳飲料", "清涼飲料水") — it is almost never the actual product name. The real product name is usually only on the front of the can, not visible in a back-label photo. If you can't see a specific branded product name anywhere in the image, set "name" to the category name you found and set "name_is_generic" to true, so the app knows to ask the user to type the real name. Do not guess a plausible-sounding product name.

4. caffeine_mg: Japanese labels are not required to print caffeine, so it's usually absent from the panel. If you recognize the specific product from its branding, use known real caffeine content and set caffeine_is_estimate to false. Otherwise estimate for a typical canned coffee of this size/type and set caffeine_is_estimate to true.

5. size_ml: read the printed content amount (内容量). Note it may be in grams (g) for milk-based drinks — treat that number the same as ml for our purposes.

6. confidence reflects overall label legibility, not the caffeine number specifically.
7. notes: one short sentence on anything unclear, estimated, or scaled.`;
  return callClaudeVision<LabelResult>(base64, mediaType, prompt, 800);
}

// Optional, user-triggered only (never automatic) — looks up the real product name
// by JAN code using the Anthropic web search tool, server-side, so there's no CORS
// issue and no cost unless the person explicitly asks for it.
export async function lookupNameByJan(jan: string): Promise<LookupResult> {
  const prompt = `Search for the Japanese drink product with JAN/barcode code ${jan}. This is likely a Japanese vending-machine can coffee or similar drink. Find the manufacturer's own product page if possible.

Respond with ONLY raw JSON, no markdown fences:
{"name": string|null, "brand": string|null, "found": boolean, "source_note": string}

If you can't confidently find this exact JAN code, set "found" to false and "name" to null rather than guessing a plausible-sounding name.`;

  const res = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
    // Basic web-search variant supported by the installed SDK. If you upgrade
    // @anthropic-ai/sdk, you can switch to "web_search_20260209" (dynamic
    // filtering) on Sonnet 4.6 / Opus 4.6+.
    tools: [{ type: "web_search_20250305", name: "web_search" }],
  });
  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  return parseJson<LookupResult>(text);
}

// Narrow an incoming media type string to one the API accepts, defaulting to jpeg.
export function normalizeMediaType(t: string | undefined): MediaType {
  if (t === "image/png" || t === "image/webp" || t === "image/gif") return t;
  return "image/jpeg";
}
