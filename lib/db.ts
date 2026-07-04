import postgres from "postgres";

// Reuse one connection pool across hot reloads in dev and across warm serverless
// invocations in prod, so we don't exhaust Postgres connections.
declare global {
  // eslint-disable-next-line no-var
  var _canlogSql: ReturnType<typeof postgres> | undefined;
}

function makeClient() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in."
    );
  }
  return postgres(url, {
    // Vercel/Neon/Supabase pooled endpoints don't support prepared statements.
    prepare: false,
    idle_timeout: 20,
    max: 5,
  });
}

const sql = global._canlogSql ?? makeClient();
if (process.env.NODE_ENV !== "production") global._canlogSql = sql;

export default sql;
