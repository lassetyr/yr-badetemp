# Supabase + Cloudflare Pages Migration — Design

**Date:** 2026-06-26
**Status:** Approved, ready for implementation planning

## Goal

Move yr-badetemp off the "repo-is-the-database" model onto Supabase (Postgres)
so that more advanced features become possible later, while making the GitHub
repo private without losing public access to the chart.

The features driving the move (from brainstorming) are:

- **A — Multiple locations/spots** beyond Dulpen
- **B — Statistics & aggregations** (daily/weekly avg, min/max, trends)
- **E — Longer history / richer server-side queries**

Explicitly **out of scope** for this migration: user accounts, alerts/
notifications.

## Scope of this spec

**Migrate first, features later.** This spec covers *only* the migration: it
reproduces today's chart but backed by Supabase, on new hosting, from a private
repo. The schema is designed so the A/B/E features slot in cleanly as follow-up
specs — but no stats UI, no multi-location UI, and no second location are built
here. Only Dulpen (`0-10238`) is written in v1.

## Architecture

The existing two-halves split is preserved: the **poller** (CI/Node) and the
**browser app** share pure helpers but never import each other. Only the data
layer underneath both changes.

| | Today | After |
|---|---|---|
| Database | `data/dulpen.ndjson` in git | Postgres table in Supabase |
| Poller writes | `appendFile` + git commit | `INSERT` via PostgREST |
| Frontend reads | `fetch` the ndjson file | `fetch` PostgREST REST endpoint |
| Static hosting | GitHub Pages (public repo) | Cloudflare Pages (private repo) |
| Repo | public | private |

Side effect: the poller no longer commits per reading, so git history becomes
readable again.

## Database schema

A single table, `readings`:

```sql
create table readings (
  location_id text not null,
  epoch       bigint not null,
  time        timestamptz not null,
  water       double precision not null,
  air         double precision,
  wind_speed  double precision,
  wind_gust   double precision,
  wind_dir    double precision,
  primary key (location_id, epoch)
);
```

- `location_id` is the **expansion seam** for multi-location (feature A). Present
  now; only `'0-10238'` is written in v1.
- The `(location_id, epoch)` primary key **is** the append-only idempotency
  guarantee — the DB equivalent of today's `shouldAppend`. Re-inserting the same
  reading is a no-op via `ON CONFLICT DO NOTHING`. The poller therefore no longer
  needs to read the last stored reading before writing.
- The primary-key index also covers the dominant read query: filter by
  `location_id`, range over `epoch`, order by `epoch`.

## Security (Row Level Security)

- Enable RLS on `readings`.
- One policy: `SELECT` permitted for the `anon` role → public read for the chart.
  No insert/update/delete for the public.
- The poller writes with the **`service_role`** key, which bypasses RLS. Stored
  as a GitHub Actions secret.
- The **anon key is shipped in the frontend** — this is by design and safe. It
  grants only what RLS permits (read-only).

## Poller changes (`scripts/`)

- `lib.js` stays pure:
  - `extractReading` — unchanged.
  - Remove `parseLastReading` and `shouldAppend` (DB now handles idempotency).
  - Add a pure `toRow(reading, locationId)` mapping a reading to the snake_case
    row payload.
- `poll.js`:
  - Replace file read/append with a `POST` to `/rest/v1/readings` carrying the
    header `Prefer: resolution=ignore-duplicates`, authenticated with the
    `service_role` key. No need to fetch existing data first.
  - Preserve the failure philosophy: network/API failures `return` (exit 0) so a
    transient blip just waits for the next scheduled poll.
- New environment (GitHub Actions secrets): `SUPABASE_URL`,
  `SUPABASE_SERVICE_KEY`.
- The `poll.yml` workflow no longer needs the git add/commit/rebase/push steps
  for data — it only runs the poll script. (`git pull --rebase` race handling
  for the data file goes away.)

## History import (one-off)

- `scripts/import-history.js`:
  - Read `data/dulpen.ndjson`.
  - Map each line to a row with `location_id = '0-10238'`.
  - Bulk-`POST` in batches with `Prefer: resolution=ignore-duplicates`.
  - Idempotent and re-runnable.
  - Run once locally with the `service_role` key.

## Frontend changes

- `src/data.js` (stays pure, no network/DOM):
  - Remove `parseNdjson` and the client-side `filterByRange`.
  - Add a **query-URL builder**: `(location, rangeKey, nowEpoch) → PostgREST URL`,
    computing the epoch cutoff for `24h`/`7d`/`30d` and emitting
    `?location_id=eq.<id>&epoch=gte.<cutoff>&order=epoch.asc&select=...`. The
    `all` range emits no epoch lower bound.
  - Add a **row mapper**: PostgREST snake_case rows → the camelCase reading shape
    `app.js` already consumes (`time`, `epoch`, `water`, `air`, `windSpeed`,
    `windGust`, `windDir`), so the charting code barely changes.
- `app.js`:
  - `loadData` fetches from Supabase with the anon-key headers (`apikey` +
    `Authorization: Bearer <anon>`).
  - **Range filtering moves server-side**: switching range now refetches just
    that window rather than filtering an in-memory full set. Accepted trade-off:
    range switches become a quick refetch instead of instant.
  - Preserved unchanged: the "do not blank a working chart on a transient fetch
    error" behavior, `Europe/Oslo` time rendering, legend on/off persistence, the
    refresh timer, and pause-while-hidden.
- New `src/config.js`: holds the public `SUPABASE_URL` and anon key.

## Hosting & cutover

Ordered cutover sequence:

1. Create the Supabase project; run schema + RLS policy + (implicit PK) index.
2. Run `import-history.js` locally; verify the row count matches the ndjson line
   count.
3. Rewrite the poller; set GitHub Actions secrets; fire one manual poll; verify a
   fresh row lands and a re-run is a no-op.
4. Rewrite the frontend read path; test locally against Supabase.
5. Connect **Cloudflare Pages** to the repo (no build command; serves the static
   files at repo root); verify the deployed site loads data.
6. Flip the repo **private**; disable GitHub Pages.
7. Confirm the poller no longer touches `data/dulpen.ndjson`; keep that file in
   git as a frozen historical backup (do not delete).

## Testing

- `lib.js`: keep `extractReading` cases; replace the `shouldAppend` test with
  `toRow` tests.
- `src/data.js`: replace `parseNdjson`/`filterByRange` tests with query-URL
  builder + row-mapper tests (still pure, no network/DOM).
- `poll.js` / `app.js` remain untested I/O shells, as today.

## Secrets summary

| Secret | Where | Role |
|---|---|---|
| `SUPABASE_URL` | GH Actions + frontend `config.js` | project URL (not secret) |
| `SUPABASE_SERVICE_KEY` | GH Actions secret only | write (bypasses RLS) |
| `SUPABASE_ANON_KEY` | frontend `config.js` (public) | read (via RLS) |

## Free-tier reality check

- **Supabase free tier** pauses a project after ~7 days of inactivity; the
  poller's regular inserts keep it warm, so this is a non-issue. Storage (~500 MB)
  and egress limits are far above this app's footprint. (Confirm current limits at
  supabase.com/pricing before committing.)
- **Cloudflare Pages free tier**: unlimited bandwidth, no commercial-use
  restriction, deploys from a private GitHub repo for free.

## Follow-up specs (not built here)

- **Multi-location**: write all spots the region API returns; add a location
  picker; possibly a `locations` metadata table.
- **Stats/aggregations**: SQL views (daily/weekly avg, min/max, "warmest day",
  trends) exposed via PostgREST, plus UI.
