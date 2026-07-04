-- CanLog schema. Two tables:
--   products — the shared, crowdsourced product cache keyed by barcode (JAN).
--   entries  — per-user drink log, with product data denormalized at log time.
--
-- All nutrition values in `products` are PER-CONTAINER TOTALS, never per-100g.
-- The per-100g -> per-container scaling and 食塩相当量 -> sodium conversion happen
-- during extraction (see lib/anthropic.ts) before anything is written here.

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
  -- Nullable: manual entries may not have a barcode. No hard FK so a logged
  -- entry never breaks if a product row is later cleaned up.
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
  -- Always user-entered. Never cached, never AI-derived, never defaulted.
  price_yen           INTEGER,
  image_url           TEXT,
  -- Per-log, user-chosen: 'hot' | 'cold' | NULL (unknown). Not part of the
  -- shared product cache — the same can may be bought hot or cold.
  temperature         TEXT,
  "timestamp"         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entries_user_time_idx
  ON entries (user_id, "timestamp" DESC);
