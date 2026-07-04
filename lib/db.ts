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

// Lazily create the client on first use. This keeps module import side-effect
// free, so the build (which imports route modules but never runs queries) never
// requires DATABASE_URL — only actual requests do.
function getClient() {
  if (!global._canlogSql) global._canlogSql = makeClient();
  return global._canlogSql;
}

const sql = new Proxy(function () {} as unknown as ReturnType<typeof postgres>, {
  apply(_target, _thisArg, args: unknown[]) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getClient() as any)(...args);
  },
  get(_target, prop) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = getClient() as any;
    const value = client[prop];
    return typeof value === "function" ? value.bind(client) : value;
  },
});

export default sql;
