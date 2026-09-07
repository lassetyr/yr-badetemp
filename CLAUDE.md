# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A water-temperature tracker for Dulpen, Holmestrand. GitHub Actions polls the
yr.no API and inserts each reading into a Supabase Postgres table; a
zero-dependency static chart (hosted on Cloudflare Pages) reads that table
directly via Supabase's PostgREST API. There is no server of our own — Supabase
*is* the backend. The repo no longer stores data: `data/dulpen.ndjson` is a
frozen historical backup of the pre-Supabase era (do not append to it).

## Supabase setup (one-time, manual)

There is no migration runner — the schema in `supabase/schema.sql` must be
applied **by hand** in the Supabase SQL editor when the project is first set up
(or ever rebuilt). It defines two tables, each with a Row Level Security
`SELECT` policy granted to `anon` so the static chart can read them:

- `readings` — the append-only observations.
- `forecast` — the single-row-per-location projection the poller upserts.

**Easy trap:** forgetting the `forecast` table (or its `anon` policy) fails
*silently* — the poller's upsert 404s but is fail-soft (readings keep flowing),
and the browser's read returns nothing, so **no** forecast line (water, air, or
wind) is ever drawn even though everything else looks healthy. If projections
don't show, verify the table and policy first:

```sql
select relrowsecurity from pg_class where relname = 'forecast';            -- expect: true
select policyname, cmd, roles from pg_policies where tablename='forecast'; -- expect: "Public read access" | SELECT | {anon}
```

## Commands

```bash
npm test                      # run all unit tests (node --test, Node 20+, zero deps)
node --test test/lib.test.js  # run a single test file

# Poller / import need credentials in the environment:
YR_API_KEY=<key> SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js
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
  A missing `YR_API_KEY` aborts the run before any fetch — there is no fallback
  provider. For forecast fitting, `fetchHistory` paginates through the reading
  history so the fit accesses the full `FIT_WINDOW_DAYS` window rather than
  Supabase's default 1000-row read cap.
- **Browser app** (`index.html` + `app.js` → `src/data.js` + `src/config.js`):
  fetches from Supabase's PostgREST endpoint and renders with ECharts. `app.js`
  owns all I/O and DOM; `src/data.js` is pure and holds every derived/formatting
  helper — URL builders (`readingsQueryUrl`, `latestReadingUrl`), the
  snake_case→camelCase `mapRow`, and the glanceability logic (`waterStats`,
  `waterTrend`, `isStale`, `humanizeAge`, `degToArrow`, `toSeriesPairs`). Each is
  unit-tested in `test/data.test.js`. Range filtering is server-side, so
  switching range re-fetches rather than filtering in memory. `loadData` pages
  that fetch (`readingsQueryUrl`'s `page` arg → `limit`/`offset`) for the same
  reason `fetchHistory` does: PostgREST *silently* truncates an unpaged read at
  1000 rows, which quietly dropped the oldest history from the `30d` and `Alle`
  charts until they were paged.

  A refresh runs two independent queries in parallel (`refresh` in `app.js`):
  `loadLatest` fetches the single newest reading for the header (so "current
  temp" stays correct even when the selected window contains no readings), while
  `loadData` fetches the selected range for the chart. Both fail soft — a
  transient error leaves the existing header/chart intact rather than blanking
  it.

- **Forecast** (`scripts/poll.js:updateForecast` → `scripts/lib.js`): each poll
  also builds a best-effort 48h water-temperature projection. `lib.js` fits a
  relaxation model `dWater/dt = a·(air−water) + b·wind` (no intercept, `c` always 0)
  against a 24-hour trailing-mean air driver (`smoothAirSeries`, `SMOOTH_WINDOW_H`)
  via `fitRelaxation`. `buildProjection` smooths that driver across the
  history→forecast seam so the early forecast averages real observations rather
  than cold-starting, then rolls the projection
  forward on the met.no forecast timeseries (`extractForecastSeries` → `rollForward`),
  sizes a confidence band from a walk-forward backtest (`backtestError`, inflated by
  `INFLATE=1.3` for forecast-input error), and assembles the payload (`buildProjection`).
  The air/wind lines shown to the user remain the raw met.no forecast (smoothing is
  internal to the water model). `poll.js` upserts one row into the `forecast` table
  (replace-on-write, keyed by `location_id`). The browser reads it via
  `forecastQueryUrl`/`mapForecast` (`src/data.js`) and draws a dashed line + shaded
  band. When the fit is untrustworthy it falls back to flat persistence
  (`model: "persistence"`).

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

The separate `forecast` table is the one exception to append-only: it holds a
single row per location, replaced each poll via `Prefer: resolution=merge-duplicates`
(ON CONFLICT DO UPDATE). It never affects `readings`.

### Scheduling reality

The poll workflow has **no `schedule:` cron** — it is triggered solely by an
external scheduler (e.g. cron-job.org) hitting the `workflow_dispatch` REST
endpoint, which `scripts/trigger.sh` documents and performs. GitHub's own
`schedule:` cron was dropped for two reasons: it is best-effort and frequently
drops sub-hourly runs, and a second trigger would double-bill Actions minutes
(both triggers fire independent, separately-billed runs; `concurrency` only
serializes overlaps, it does not dedupe them). So the poll cadence lives
entirely in the external scheduler's configuration.

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
- Secrets: `YR_API_KEY` (official water API; **required**), plus `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY`.
- Forecast model tunables (constants in `scripts/lib.js`): `FIT_WINDOW_DAYS`,
  `MIN_GAP_S`/`MAX_GAP_S`, `MIN_PAIRS`, `HORIZON_H`, `SMOOTH_WINDOW_H`, `INFLATE`,
  `BACKTEST_HORIZONS`/`BACKTEST_STRIDE`, `FALLBACK_ERR`.
- Browser refresh cadence: `REFRESH_MS` in `app.js` (auto-refetches without page
  reload; pauses while the tab is hidden).
- Poll cadence: configured in the external scheduler (cron-job.org) that hits
  `workflow_dispatch`; the workflow itself has no `schedule:` cron.

## Design docs

Specs and plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` — check there for the intended behavior behind a
feature before changing it.
