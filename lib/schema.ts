// Canonical schema, importable at runtime (the serverless setup route can't read
// db/schema.sql from disk). db/schema.sql mirrors this for manual/psql use.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  jan                 TEXT PRIMARY KEY,
  brand               TEXT,
  name                TEXT,
  size_ml             INTEGER,
  calories            NUMERIC,
  carbs_g             NUMERIC,
  protein_g           NUMERIC,
  fat_g               NUMERIC,
  sodium_mg           NUMERIC,
  caffeine_mg         NUMERIC,
  caffeine_is_estimate BOOLEAN NOT NULL DEFAULT TRUE,
  confidence          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             TEXT NOT NULL,
  jan                 TEXT,
  brand               TEXT,
  name                TEXT,
  size_ml             INTEGER,
  calories            NUMERIC,
  carbs_g             NUMERIC,
  protein_g           NUMERIC,
  fat_g               NUMERIC,
  sodium_mg           NUMERIC,
  caffeine_mg         NUMERIC,
  caffeine_is_estimate BOOLEAN NOT NULL DEFAULT TRUE,
  price_yen           INTEGER,
  image_url           TEXT,
  "timestamp"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entries_user_time_idx
  ON entries (user_id, "timestamp" DESC);
`;
