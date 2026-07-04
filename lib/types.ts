// Shapes shared between the API routes and the client.

export type Confidence = "high" | "medium" | "low" | "manual";

// A product as stored in the shared cache (per-container totals).
export interface Product {
  jan: string;
  brand: string;
  name: string;
  size_ml: number;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  sodium_mg: number;
  caffeine_mg: number;
  caffeine_is_estimate: boolean;
  confidence: Confidence;
}

// Stage 1 result — just the barcode.
export interface BarcodeResult {
  jan: string | null;
  readable: boolean;
}

// Stage 2 result — the nutrition label read.
export interface LabelResult {
  brand: string;
  name: string;
  name_is_generic: boolean;
  size_ml: number;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  sodium_mg: number;
  caffeine_mg: number;
  caffeine_is_estimate: boolean;
  confidence: Exclude<Confidence, "manual">;
  notes: string;
}

// Optional user-triggered JAN lookup result.
export interface LookupResult {
  name: string | null;
  brand: string | null;
  found: boolean;
  source_note: string;
}

// A logged entry as returned to the client.
export interface Entry {
  id: string;
  jan: string | null;
  brand: string;
  name: string;
  size_ml: number;
  calories: number;
  carbs_g: number;
  protein_g: number;
  fat_g: number;
  sodium_mg: number;
  caffeine_mg: number;
  caffeine_is_estimate: boolean;
  price_yen: number;
  image_url: string | null;
  temperature: "hot" | "cold" | null;
  timestamp: string;
}
