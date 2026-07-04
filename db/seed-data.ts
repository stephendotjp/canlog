// Starter seed for the shared products cache.
//
// IMPORTANT — read before adding rows:
//   * Per the CanLog spec, product data must be REAL, not guessed. Names must be
//     the actual front-of-can product name (never the 名称 food-category label),
//     and all nutrition values must be PER-CONTAINER TOTALS (already scaled from
//     per-100g, salt already converted to sodium). Price is never stored here.
//   * Only rows with `verified: true` are inserted by `npm run db:seed`. Every
//     stub below is `verified: false` on purpose so the seed does nothing until a
//     human fills in and checks the real figures.
//
// The one JAN confirmed by real testing (Cherio "Blues Coffee") is included so
// the mapping is captured, but its nutrition is still TODO — flip `verified` to
// true only once every number is confirmed from the actual can.

export interface SeedProduct {
  jan: string;
  brand: string;
  name: string;
  size_ml: number | null;
  calories: number | null;
  carbs_g: number | null;
  protein_g: number | null;
  fat_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number | null;
  caffeine_is_estimate: boolean;
  confidence: "high" | "medium" | "low" | "manual";
  verified: boolean;
}

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    // Confirmed JAN from real testing; nutrition still needs to be entered.
    jan: "4902074015552",
    brand: "Cherio",
    name: "Blues Coffee",
    size_ml: 185,
    calories: null, // TODO: per-container total from the can
    carbs_g: null,
    protein_g: null,
    fat_g: null,
    sodium_mg: null, // TODO: convert 食塩相当量 g × 1000 ÷ 2.54, then scale
    caffeine_mg: null,
    caffeine_is_estimate: true,
    confidence: "manual",
    verified: false,
  },

  // --- Popular vending brands — fill in real JAN + per-container nutrition ---
  // Each product variant has its own JAN; the brand alone isn't enough. Add one
  // row per specific can, set the real numbers, then `verified: true`.
  //
  // { jan: "TODO", brand: "Suntory",   name: "BOSS Rainbow Mountain", size_ml: 185, calories: null, carbs_g: null, protein_g: null, fat_g: null, sodium_mg: null, caffeine_mg: null, caffeine_is_estimate: true, confidence: "manual", verified: false },
  // { jan: "TODO", brand: "Coca-Cola", name: "Georgia Emerald Mountain", size_ml: 185, ... },
  // { jan: "TODO", brand: "Asahi",     name: "Wonda Morning Shot", size_ml: 185, ... },
  // { jan: "TODO", brand: "Doutor",    name: "Doutor Blend Coffee", size_ml: 240, ... },
];
