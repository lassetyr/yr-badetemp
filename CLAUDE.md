# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A water-temperature tracker for Dulpen, Holmestrand. GitHub Actions polls the
yr.no API and inserts each reading into a Supabase Postgres table; a
zero-dependency static chart (hosted on Cloudflare Pages) reads that table
directly via Supabase's PostgREST API. There is no server of our own — Supabase
*is* the backend. The repo no longer stores data: `data/dulpen.ndjson` is a
frozen historical backup of the pre-Supabase era (do not append to it).

## Commands

```bash
npm test                      # run all unit tests (node --test, Node 20+, zero deps)
node --test test/lib.test.js  # run a single test file

# Poller / import need Supabase credentials in the environment:
# YR_API_KEY is optional — set it to poll the official Yr API, omit it to fall
# back to the unofficial endpoint (temporary scaffold until the key lands).
[YR_API_KEY=<key>] SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js
SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/import-history.js  # one-off backfill from the ndjson

python3 -m http.server 8000   # serve the site locally → http://localhost:8000/
GITHUB_TOKEN=<pat> ./scripts/trigger.sh   # manually fire the poll workflow (expect HTTP 204)
```

There is no build step, bundler, or lint config. ECharts is loaded from a CDN in
`index.html`; the browser code uses native ES modules. The frontend's public
Supabase URL + publishable key live in `src/config.js` (the publishable key is
read-only via RLS and is meant to ship in client code).

## Architecture

Two halves share pure helpers but never import each other:

- **Poller** (`scripts/poll.js` → `scripts/lib.js`): runs in CI/Node. `poll.js`
  does all I/O — water temperature from the official `badetemperaturer.yr.no`
  API (`apikey` header), air/wind from MET Norway Locationforecast 2.0
  (`User-Agent` header), then POSTs one water-anchored row to Supabase. `lib.js`
  is pure: `extractOfficialWater` picks the newest official water reading,
  `extractForecast` pulls instant air/wind from the met.no response, `buildRow`
  maps them to the snake_case DB row. Failures `return` rather than throw — the
  run exits 0, and a met.no blip still yields a water-only row (air/wind null).
  When `YR_API_KEY` is unset the poller instead falls back to the pre-transition
  unofficial GeoJSON endpoint (`www.yr.no/api/v0/watertemperatures/...`, one call
  carrying water + air + wind) via `extractReading`/`toRow` — a temporary
  scaffold so data keeps flowing until the key lands; it is removed at cutover.
- **Browser app** (`index.html` + `app.js` → `src/data.js` + `src/config.js`):
  fetches the selected time range from Supabase's PostgREST endpoint and renders
  with ECharts. `src/data.js` is pure (`readingsQueryUrl` builds the PostgREST
  query URL for a location + range; `mapRow` converts a snake_case row to the
  camelCase shape the chart consumes). Range filtering is server-side, so
  switching range re-fetches rather than filtering in memory.

`lib.js` and `src/data.js` are deliberately I/O-free so the tests can exercise
logic without network or DOM. When adding logic, put the pure part in those
files and keep side effects in `poll.js` / `app.js`.

### Append-only data invariant

The `readings` table is keyed by a composite primary key `(location_id, epoch)`
(see `supabase/schema.sql`). The poller and the one-off importer both POST with
`Prefer: resolution=ignore-duplicates`, so re-inserting an existing reading is a
no-op (`ON CONFLICT DO NOTHING`) — re-runs and overlapping polls are idempotent
and never create duplicates. This PK is what replaced the old `shouldAppend`
check. Don't add an `UPDATE`/`DELETE` write path; readings are append-only.

Reads are public via a Row Level Security `SELECT` policy granted to the `anon`
role (the publishable key authenticates as `anon`). Writes use the secret key
(`SUPABASE_SERVICE_KEY`), which bypasses RLS and is only ever set server-side
(GitHub Actions secret / local env) — never in `src/config.js`.

### Scheduling reality

GitHub's `schedule:` cron is best-effort and frequently drops sub-hourly runs,
so the cron in `poll.yml` is only a fallback. The reliable path is an external
scheduler (e.g. cron-job.org) hitting the `workflow_dispatch` REST endpoint —
that's what `scripts/trigger.sh` documents and performs. The cron minutes
(`7,27,47`) are intentionally offset off `:00/:20/:40` to dodge GitHub's most
congested scheduler slots.

## Conventions

- All user-facing time is rendered in `Europe/Oslo` regardless of the viewer's
  device timezone (see `osloParts` in `app.js`). UI labels are in Norwegian.
- The poll workflow no longer commits to the repo — it just runs the inserting
  poll script. `concurrency.group: poll` still serializes overlapping runs, and
  the `(location_id, epoch)` PK makes a race harmless even if two overlap.
- `STORAGE_ID` is currently only `"0-10238"` (Dulpen) — the id written to the
  `location_id` column. That column exists as the seam for adding more spots
  later, but only Dulpen is written. (`QUERY_ID`, sent to the Yr API, is
  tracked separately in `scripts/poll.js`.)

## Config knobs

- Tracked spot: `STORAGE_ID` (written to `location_id`), `QUERY_ID` (sent to
  badetemperaturer.yr.no), and `LAT`/`LON` in `scripts/poll.js`. `STORAGE_ID`
  (`"0-10238"`) is also the read-query id in `app.js`. The water + forecast
  endpoint URLs and `MET_USER_AGENT` are constants in `scripts/poll.js`.
- Secrets: `YR_API_KEY` (official water API; **optional** — unset falls back to
  the unofficial endpoint), plus `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.
- Browser refresh cadence: `REFRESH_MS` in `app.js` (auto-refetches without page
  reload; pauses while the tab is hidden).
- Poll cadence: the `cron` in `.github/workflows/poll.yml` and the external
  scheduler.

## Design docs

Specs and plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` — check there for the intended behavior behind a
feature before changing it.
