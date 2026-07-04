import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { loadEnv } from "./loadEnv";

loadEnv();

async function main() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const sql = postgres(url, { prepare: false });
  const schema = readFileSync(join(process.cwd(), "db", "schema.sql"), "utf8");
  await sql.unsafe(schema);
  console.log("✓ schema applied (products, entries)");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
