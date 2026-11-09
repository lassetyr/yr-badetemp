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
(or ever rebuilt). It defines three tables, each with a Row Level Security
`SELECT` policy granted to `anon`:

- `readings` — the append-only observations.
- `forecast` — the single-row-per-location projection the poller upserts.
- `forecast_archive` — append-only hourly snapshots of that projection, kept for
  calibration. The site never reads it; the `anon` policy exists so analysis
  scripts can use the publishable key.

**Easy trap:** forgetting the `forecast` table (or its `anon` policy) fails
*silently* — the poller's upsert 404s but is fail-soft (readings keep flowing),
and the browser's read returns nothing, so **no** forecast line (water, air, or
wind) is ever drawn even though everything else looks healthy. If projections
don't show, verify the table and policy first:

```sql
select relrowsecurity from pg_class where relname = 'forecast';            -- expect: true
select policyname, cmd, roles from pg_policies where tablename='forecast'; -- expect: "Public read access" | SELECT | {anon}
```

`forecast_archive` fails the same way but even more quietly: nothing user-facing
breaks at all, the archive simply never fills. If it looks empty, check the table
exists before suspecting the poller:

```sql
select count(*), max(generated_at) from forecast_archive;  -- expect: growing, ~24 rows/day
```

## Commands

```bash
npm test                      # run all unit tests (node --test, Node 20+, zero deps)
node --test test/lib.test.js  # run a single test file

# Poller / import need credentials in the environment:
YR_API_KEY=<key> SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js
SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/import-history.js  # one-off backfill from the ndjson

# Forecast analysis (read-only, uses the publishable key, no secrets):
node scripts/analysis/score-archive.mjs   # score archived projections vs what the sensor measured
node scripts/analysis/replay-archive.mjs  # replay model variants on archived met.no inputs + a walk-forward

python3 -m http.server 8000   # serve the site locally → http://localhost:8000/
GITHUB_TOKEN=<pat> ./scripts/trigger.sh   # manually fire the poll workflow (expect HTTP 204)
```

There is no build step, bundler, or lint config. ECharts is loaded from a CDN in
`index.html`; the browser code uses native ES modules. The frontend's public
Supabase URL + publishable key live in `src/config.js` (the publishable key is
read-only via RLS and is meant to ship in client code).

## Architecture

Two halves share pure helpers but never import each other:

- **Poller** (`scripts/poller.js` → `scripts/lib.js`): `poller.js` exports
  `runPoll(config)`; `scripts/poll.js` is the thin entry point that reads the
  secrets from `process.env` and calls it (GitHub Actions, the Raspberry Pi timer
  in `pi/`, or by hand). Secrets and `fetch` are passed in, so
  `test/poller.test.js` runs whole polls against a fake fetch. It does all I/O — water temperature from the official `badetemperaturer.yr.no`
  API (`apikey` header), air/wind from MET Norway Locationforecast 2.0
  (`User-Agent` header), then POSTs the water-anchored rows to Supabase. `lib.js`
  is pure: `extractOfficialWaters` canonicalises every returned water reading,
  `extractForecast` pulls instant air/wind from the met.no response, `buildRow`
  maps them to the snake_case DB row. Failures `return` rather than throw — the
  run exits 0, and a met.no blip still yields a water-only row (air/wind null).
  A missing `YR_API_KEY` aborts the run before any fetch — there is no fallback
  provider.

  **Each poll inserts five readings, not one.** The official endpoint serves the
  five most recent registrations for the location, and the sensor reports about
  every 10 minutes — so a poll that kept only the newest was discarding ~40% of
  the sensor's data (measured 2026-09-07: 593 rows stored, ~390 missed in a
  week). `pollOfficial` now maps all of them through `buildRow` and posts the
  array; the `(location_id, epoch)` PK turns the four the previous poll already
  stored into no-ops, so overlap is free. This decouples poll cadence from
  completeness: **any interval up to ~40 min is lossless** (five readings span
  ≈50 min), so polling less often now stores more data than polling often did.
  Every row from one poll carries that poll's met.no air/wind — met.no's instant
  values are hourly-granular so the feed always carried this approximation, and
  nulls would break the chart's air/wind lines, which split at null. For forecast fitting, `fetchHistory` paginates through the reading
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
  1000 rows, which quietly dropped the oldest history from the `30d` and (then) `Alle`
  charts until they were paged.

  A refresh runs two independent queries in parallel (`refresh` in `app.js`):
  `loadLatest` fetches the single newest reading for the header (so "current
  temp" stays correct even when the selected window contains no readings), while
  `loadData` fetches the selected range for the chart. Both fail soft — a
  transient error leaves the existing header/chart intact rather than blanking
  it.

- **Forecast** (`scripts/poller.js:updateForecast` → `scripts/lib.js`): each poll
  also builds a 48h projection, and **it is deliberately flat**: `buildProjection`
  holds the last measured water temperature for every met.no forecast step
  (`extractForecastSeries`) and wraps it in a band whose half-width at each
  horizon is the 0.8 quantile of how far the water actually moved over that many
  hours in the last `FIT_WINDOW_DAYS` (`persistenceError`, `BAND_QUANTILE`). That
  band is measured on real outcomes, so it needs no inflation factor; a trailing
  30-day quantile covered 81–85% of later outcomes it had not seen. Each point
  also carries the raw met.no air/wind, which the chart draws as the air and wind
  forecast lines.

  **Why flat (2026-11-09):** the relaxation model it replaced
  (`dWater/dt = a·(air−water)` on a 24h mean-air driver) lost to persistence on
  the archived met.no forecasts at every horizon, with a cold bias growing to
  −0.5 °C at 48h. Root cause: water does not settle at air temperature but at a
  seasonal offset from it (−1.9 °C in June, +3.8 °C in November) because the
  fjord lags the season. Fitting that offset removed the bias but made every
  horizon worse, and none of six variants beat a flat line on both test sets.
  **Do not ship a model again without beating persistence in
  `scripts/analysis/replay-archive.mjs` on both its test sets.** Keep projection
  work near-linear in history size: it is the only CPU-heavy step of a poll
  (`persistenceError` binary-searches, ~1 ms on a 30-day window).

  `poller.js` upserts one row into the `forecast` table (replace-on-write,
  keyed by `location_id`) and appends an hourly snapshot to `forecast_archive`
  (`archiveForecast`). The archive is what made the model above measurable, since
  the single-row `forecast` table keeps no history, and it keeps paying off:
  every snapshot stores the met.no air forecast beside our projection, so
  `replay-archive.mjs` can score any future model on the inputs it would really
  have had, and `score-archive.mjs` checks the band's coverage. Its key is
  `(location_id, hour_epoch)` where `hour_epoch` is `hourBucket(generated_at)`,
  so the first poll of each hour inserts and the rest are ignore-duplicate
  no-ops — ~24 rows/day, no state in the poller. The browser reads the forecast
  via `forecastQueryUrl`/`mapForecast` (`src/data.js`) and draws a dashed line +
  shaded band.

  **Stored horizon and drawn horizon differ on purpose.** The poller always
  stores the full `HORIZON_H` (48h); `forecastHorizonFor` (`src/data.js`) caps
  what the chart draws — 12h on the 24t range, 24h everywhere else — and
  `clampForecast` trims every forecast series to it. Past ~24h the band is wide
  enough to say little, and the met.no air forecast it sits beside gets weaker
  too. The extra stored hours are kept because they cost nothing and are part
  of the archive's record for scoring future models.

`lib.js` and `src/data.js` are deliberately I/O-free so the tests can exercise
logic without network or DOM. When adding logic, put the pure part in those
files and keep side effects in `poller.js` / `app.js`.

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

(Alternative: `pi/` runs the same `scripts/poll.js` from a systemd timer on a
Raspberry Pi — no CPU limit, no Actions minutes, see `pi/README.md`. Every write
is idempotent, so it can overlap the Actions poll during a switch-over. Until
cron-job.org is switched off, the paragraph below is how the Actions poll runs.
A Cloudflare Worker was tried and dropped: it measured 22 ms CPU per run against
the Free plan's 10 ms.)

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
  tracked separately in `scripts/poller.js`.)

## Config knobs

- Tracked spot: `STORAGE_ID` (written to `location_id`), `QUERY_ID` (sent to
  badetemperaturer.yr.no), and `LAT`/`LON` in `scripts/poller.js`. `STORAGE_ID`
  (`"0-10238"`) is also the read-query id in `app.js`. The water + forecast
  endpoint URLs and `MET_USER_AGENT` are constants in `scripts/poller.js`.
- Secrets: `YR_API_KEY` (official water API; **required**), plus `SUPABASE_URL` /
  `SUPABASE_SERVICE_KEY`.
- Forecast tunables (constants in `scripts/lib.js`): `FIT_WINDOW_DAYS` (history
  the band is measured over), `HORIZON_H`, `BAND_QUANTILE`,
  `BAND_HORIZONS`/`BAND_STRIDE`, `FALLBACK_ERR`.
- Browser refresh cadence: `REFRESH_MS` in `app.js` (auto-refetches without page
  reload; pauses while the tab is hidden).
- Poll cadence: configured in the external scheduler (cron-job.org) that hits
  `workflow_dispatch`; the workflow itself has no `schedule:` cron. Since each
  poll inserts the five most recent readings, anything up to ~40 min is lossless
  — the interval controls how fresh the page looks, not how complete the data is.

## Design docs

Specs and plans live in `docs/superpowers/specs/` and
`docs/superpowers/plans/` — check there for the intended behavior behind a
feature before changing it.
