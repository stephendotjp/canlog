# CanLog — Rebuild Spec for Claude Code

## What this is

A prototype of CanLog already exists as a single-file React artifact (attached: `canlog.jsx`). It works, and its core logic has been tested against a real can photo and refined through several rounds of fixing real bugs. Your job is not to redesign the product — it's to **rebuild the same logic on real infrastructure**: a proper backend, a real database, and a deployable Next.js app on Vercel, hosted on GitHub.

Read `canlog.jsx` first. It's the source of truth for behavior. This document explains *why* it works the way it does, so you don't accidentally regress fixes that came from real testing.

## Product summary

CanLog lets someone in Japan log the coffee they drink by taking a photo of the **back** of a can/bottle (not the front). It reads the barcode and nutrition label, logs calories/caffeine/nutrition/price per drink, and generates a monthly "Wrapped"-style recap (total cups, spend, caffeine, favorite brand, etc.).

The core insight the whole architecture is built around: **most cans of the same product get scanned by many different users over time. Caching product data by barcode (JAN code) means only the first scan of a new product ever needs a full AI read — every scan after that is instant and free.** This is the actual product moat, not the UI.

## Tech stack

- **Next.js** (App Router), deployed on **Vercel**
- **Postgres** (Vercel Postgres or Supabase — your call, pick whichever is simpler to wire up) for the shared product database
- **Vercel Blob** or similar for storing scanned images, if we keep them (optional — see open questions)
- Auth: start with a simple anonymous device ID or a lightweight auth provider (Clerk/Auth.js) — doesn't need to be elaborate for v1
- Anthropic API (`claude-sonnet-4-6`) called from **server-side API routes only** — never from the client. This matters, see "Why server-side" below.

## Data model

Two core tables:

**`products`** (shared across all users — the crowdsourced cache)
- `jan` (text, primary key) — the barcode
- `brand` (text)
- `name` (text) — the real product name, human-entered or looked-up, never AI-guessed from the label alone
- `size_ml` (int)
- `calories`, `carbs_g`, `protein_g`, `fat_g`, `sodium_mg` (numeric) — always **per-container totals**, never per-100g
- `caffeine_mg` (numeric)
- `caffeine_is_estimate` (boolean)
- `confidence` (text: high/medium/low/manual)
- `created_at`, `updated_at`

**`entries`** (per-user log)
- `id` (uuid, primary key)
- `user_id` (text/uuid)
- `jan` (text, foreign key to products, nullable — manual entries may not have one)
- `brand`, `name`, `size_ml`, `calories`, `carbs_g`, `protein_g`, `fat_g`, `sodium_mg`, `caffeine_mg`, `caffeine_is_estimate` — denormalized copy of the product data **at time of logging**, so later corrections to the shared product record don't silently rewrite someone's history
- `price_yen` (int) — always user-entered, never cached or AI-derived (see below)
- `image_url` (text, nullable)
- `timestamp` (timestamptz)

## The core flow (already validated in the prototype)

```
User photographs the BACK of the can
   ↓
Stage 1 (small/cheap API call): read just the barcode digits
   ↓
Server checks `products` table for that JAN
   ├─ HIT  → return cached product data instantly. No further AI call.
   └─ MISS → Stage 2 (fuller API call): read the nutrition label
              → return to client as a draft for the user to confirm/edit
              → on save, upsert into `products` table using the
                USER-CONFIRMED values, not the raw AI output (see bug below)
```

## Lessons already learned — please don't reintroduce these bugs

These were all real issues found by testing against an actual Japanese can (a Cherio "Blues Coffee" can, JAN 4902074015552). Build the prompts and logic to handle them from day one:

1. **Japanese nutrition labels are usually printed "per 100g" (製品100gあたり), not per container.** If you take the printed numbers at face value, you undercount by roughly half for a typical 185g can. The extraction prompt must detect which basis is printed and scale by `container_size / 100` before storing. Store only per-container totals in the database — never store raw per-100g numbers.

2. **Japanese labels print 食塩相当量 (salt equivalent, in grams), not sodium.** Convert with `sodium_mg = salt_g × 1000 ÷ 2.54` before scaling to per-container.

3. **The "name" field on a Japanese label (名称) is a legal food-category label** (e.g. "コーヒー", "乳飲料"), almost never the actual product name — the real name is only on the front of the can, not visible in a back-label photo. The AI must not guess a plausible product name here. Flag it (`name_is_generic: true`) and require the human to type the real name, or trigger an explicit user-initiated lookup (see below). Never silently save the generic category name as if it were the product name.

4. **Don't cache immediately after the AI's first pass.** Cache only after the user confirms/corrects the draft — otherwise a wrong or generic name (see #3) gets permanently baked into the shared product database for every future user who scans that barcode. This was a real bug in the prototype; the fix was moving the cache-write to the save step, using final corrected values.

5. **Price is never AI-derived, never cached, and never defaulted from history.** The same product's price varies by ¥30–50+ between vending machines and stores even in the same city. It must always be a plain, empty, user-typed field. Do not try to be clever here — this was explicitly tested and rejected. Don't waste an API call or a web search trying to guess it.

6. **Caffeine is very often absent from Japanese labels entirely** — it's not a legally required field. Always allow it to be an estimate (`caffeine_is_estimate: true`), and only mark it as a known real value if the AI genuinely recognizes the specific product from its own knowledge.

7. **Direct client-side `fetch()` to manufacturer websites will hit CORS failures.** If you ever want to look up a product name or details from an external site (a manufacturer's page, a barcode database, etc.), do it from a **server-side API route**, not from the browser. This is also why any AI web-search-based lookup should go through the server, using the Anthropic API's web search tool or a proper backend HTTP request — not a raw browser fetch to a third-party domain.

8. **JAN-to-product-name lookup by web search is unreliable enough that it should stay optional and user-triggered, not automatic.** Testing showed it works well for some manufacturers (e.g. Cherio publishes clean per-JAN pages) and poorly for others. Keep it as an explicit "look up online" action the user can choose to spend a bit more time/cost on, not something that runs by default on every new product. This also keeps AI/API costs predictable.

9. **Don't show raw technical explanation text to the user by default** (e.g. "nutrition panel was per 100g, scaled by 1.85..."). The target user is often mid-errand, holding a can, wanting to scan and move on. Any such detail should be tucked behind a collapsed "details" disclosure, not shown inline. The main confirm screen should show only: photo, brand, name, size, caffeine, price, and a single obvious "Log it" action. Everything else is secondary.

## UX priorities, in order

1. **Speed for the common case**: photo → (barcode found in cache, instant fill) → confirm price → log. This should be as close to a 2-tap flow as possible.
2. **Honesty over polish**: if something is an estimate or unknown, say so plainly, but don't bury the user in caveats.
3. **Mobile-first, visual** — this was explicitly requested. The current prototype's visual design was intentionally deprioritized in favor of correct data; feel free to redesign the UI more seriously now that the data model is right, but keep the interaction flow above.

## Open questions to flag back to the user (don't just decide silently)

- Do we store the actual scanned photo (privacy/storage cost) or discard it after extraction?
- Auth strategy for v1 — anonymous device-based tracking vs. real accounts?
- Should the "Wrapped" monthly recap be shareable (e.g. a public image/link), given that's a viral loop similar to Spotify Wrapped?
- Should the product database ever get pre-seeded with a manually researched starter set of popular Japanese vending brands (BOSS, Georgia, Wonda, Doutor, etc.)? This was discussed but not yet built — worth asking the user if they want to provide or commission that seed data before/after initial launch.

## Reference implementation

The attached `canlog.jsx` is a working single-file React prototype (using an artifact-only `window.storage` key-value mechanism that won't exist in the real app — replace all of that with real Postgres calls). Use its prompts, field structure, and confirm-card logic as the behavioral reference, but rebuild the persistence and API layers properly.
