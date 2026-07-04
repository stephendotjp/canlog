# CanLog

Log the canned coffee you drink in Japan by photographing the **back** of the can.
CanLog reads the barcode and nutrition label, logs calories/caffeine/nutrition/price
per drink, and generates a monthly "Wrapped"-style recap.

The architecture is built around one idea: **product data is cached by barcode (JAN)
and shared across all users.** Only the first scan of a new product needs a full AI
read — every scan after that is instant and free.

## Stack

- **Next.js** (App Router) — deploy on Vercel
- **Postgres** (Vercel Postgres / Neon / Supabase — any `DATABASE_URL`)
- **Vercel Blob** — stores scanned photos
- **Anthropic API** (`claude-sonnet-4-6`) — called **only** from server-side API routes
- Auth: anonymous device ID (localStorage UUID), no login

## The scan flow

```
Photograph the BACK of the can
  → POST /api/scan/barcode     (Stage 1: cheap, reads just the JAN — runs every scan)
  → GET  /api/products/[jan]    (cache check in the shared products table)
      HIT  → fill instantly from cache, no further AI call
      MISS → POST /api/scan/label   (Stage 2: full nutrition read — only on a miss)
  → user confirms / edits the draft
  → POST /api/entries          (logs the entry AND upserts the product cache,
                                using the USER-CONFIRMED values)
```

Validated behaviors baked into the prompts and save logic (see `lib/anthropic.ts`
and `app/api/entries/route.ts`):

1. Japanese panels are often per-100g — scaled to per-container before storing.
2. 食塩相当量 (salt) is converted to sodium (`mg = g × 1000 ÷ 2.54`).
3. The 名称 field is a food-category label, not a product name — flagged, never guessed.
4. The product cache is written **on confirm**, using corrected values — never on the raw AI pass.
5. Price is always user-entered — never cached, AI-derived, or defaulted.
6. Caffeine may be an estimate; marked as such.
7/8. Name lookup by JAN is server-side (no CORS) and **user-triggered only** (`/api/lookup`).
9. Technical scaling notes are tucked behind a "Scan details" disclosure.

## API routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/scan/barcode` | POST | Stage 1 — read the JAN barcode |
| `/api/products/[jan]` | GET | Cache check (hit/miss) |
| `/api/scan/label` | POST | Stage 2 — read the nutrition label (on cache miss) |
| `/api/lookup` | POST | Optional, user-triggered JAN → name web search |
| `/api/entries` | GET / POST | List the device's log / log an entry + upsert product cache |
| `/api/entries/[id]` | DELETE | Delete one of the device's entries |
| `/api/upload` | POST | Store a scanned photo in Vercel Blob |

The device identity is sent as the `x-device-id` header (a localStorage UUID).

## Local setup

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL and ANTHROPIC_API_KEY
npm run db:migrate             # create the products + entries tables
npm run db:seed                # optional — see "Seed data" below
npm run dev
```

Open http://localhost:3000. Without `BLOB_READ_WRITE_TOKEN`, logging still works;
entries just won't get a stored thumbnail.

## Seed data

`db/seed-data.ts` holds a starter list of popular vending brands. **Nothing is
inserted by default** — every row is `verified: false`, because product names and
per-container nutrition must be real, not guessed (spec rules #3 and #5). The one
JAN confirmed by testing (Cherio "Blues Coffee", `4902074015552`) is included but its
nutrition is still a TODO. Fill in the real numbers, flip `verified: true`, then run
`npm run db:seed`.

## Data model

**`products`** (shared cache) — `jan` (PK), `brand`, `name`, `size_ml`, `calories`,
`carbs_g`, `protein_g`, `fat_g`, `sodium_mg`, `caffeine_mg`, `caffeine_is_estimate`,
`confidence`, timestamps. All nutrition is per-container totals.

**`entries`** (per-device log) — `id` (uuid), `user_id`, `jan` (nullable), a
denormalized copy of the product data **at log time**, `price_yen`, `image_url`,
`timestamp`.

Schema: `db/schema.sql`.

## Deploying on Vercel

1. Push to GitHub, import the repo in Vercel.
2. Add a Postgres store and a Blob store (Storage tab) — `DATABASE_URL` and
   `BLOB_READ_WRITE_TOKEN` are injected automatically.
3. Add `ANTHROPIC_API_KEY` as an environment variable.
4. Run the migration once against the production DB (`npm run db:migrate` with the
   production `DATABASE_URL`, or paste `db/schema.sql` into the DB console).

## Not yet built (open questions deferred to later)

- Shareable "Wrapped" (public image/link) — currently private, in-app only.
- Real accounts — currently anonymous per-device.
