import postgres from "postgres";
import { loadEnv } from "./loadEnv";
import { SEED_PRODUCTS } from "./seed-data";

loadEnv();

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const sql = postgres(url, { prepare: false });

  const verified = SEED_PRODUCTS.filter((p) => p.verified);
  const skipped = SEED_PRODUCTS.length - verified.length;

  for (const p of verified) {
    await sql`
      INSERT INTO products (
        jan, brand, name, size_ml, calories, carbs_g, protein_g, fat_g,
        sodium_mg, caffeine_mg, caffeine_is_estimate, confidence
      ) VALUES (
        ${p.jan}, ${p.brand}, ${p.name}, ${p.size_ml}, ${p.calories}, ${p.carbs_g},
        ${p.protein_g}, ${p.fat_g}, ${p.sodium_mg}, ${p.caffeine_mg},
        ${p.caffeine_is_estimate}, ${p.confidence}
      )
      ON CONFLICT (jan) DO NOTHING
    `;
  }

  console.log(`✓ seeded ${verified.length} verified product(s)`);
  if (skipped > 0) {
    console.log(
      `  (${skipped} stub row(s) skipped — set verified:true in db/seed-data.ts once the real numbers are filled in)`
    );
  }
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
