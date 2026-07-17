# Design: 48-hour water-temperature projection

**Date:** 2026-07-17
**Status:** Approved — ready to plan
**Branch:** `feat/water-temperature-forecast`

## Problem

The site tracks *observed* water temperature but offers no sense of where it's
heading. We can fetch forecasts of air temperature and wind (met.no), but there
is no upstream water-temperature forecast. The question: can we synthesize a
useful short-term water-temperature projection from the data we already have?

Yes. Water temperature has strong thermal inertia — in a shallow bay it drifts
over *days*, driven mostly by how far air temperature sits above/below the water
and by wind mixing. We already store a month-plus of `(water, air, wind_speed)`
readings at ~20-min cadence, which is exactly the training data for a simple
relaxation model, and the poller already fetches the forward air/wind forecast
that drives it. This spec adds a best-effort 48-hour projection with a visible
confidence band.

## Goal

Project water temperature 48 hours ahead and render it as a dashed continuation
of the water line with a shaded confidence band that widens with the horizon —
so a glance conveys both "where it's heading" and "how much to trust it."

## Decisions (settled during brainstorming)

- **Purpose: both projection and visible trust.** A dashed forward line *and* a
  band that makes forecast-confidence decay visible — not just a projected line,
  and not just an accuracy number.
- **Horizon: 48 hours.** The sweet spot between useful and defensible — met.no's
  air/wind forecast is most reliable here, and thermal inertia makes ~2 days the
  range where a water projection is trustworthy. Extendable later once more
  history accumulates to validate against.
- **Compute side: the poller (server).** The poller can query full history for
  the fit and already fetches the met.no forecast; browsers can't set the
  `User-Agent` met.no requires, so browser-side forecast fetches are ruled out.
  The browser only draws. Pure model logic lives in `scripts/lib.js`; all I/O
  stays in `poll.js`.
- **Trust rendering: a confidence band** (dashed line + shaded band that widens
  with horizon), not a single error badge.

## Architecture & data flow

The existing seam is unchanged: all I/O in `poll.js`, all parsing/derivation
pure in `lib.js` (server) and `src/data.js` (browser). Each poll, after
inserting the new reading:

```
poll.js (per poll, appended to the existing flow)
  after insertRow(row):
    history  ← GET {SUPABASE_URL}/rest/v1/readings           // ~30d, this location
               select water,air,wind_speed,epoch; order epoch.asc
    fcSeries ← extractForecastSeries(metnoJson)              // hours 1..48 of the
               // met.no response poll.js ALREADY fetched (today it keeps hour 0)
    coeffs   ← fitRelaxation(history)                        // pure, OLS
    proj     ← buildProjection(history, fcSeries, coeffs)    // pure: roll + band
    upsertForecast(proj)                                     // replace one row
```

The browser adds one parallel query (alongside `loadLatest`/`loadData`) for the
single `forecast` row and renders it. Everything fails soft: a missing/failed
forecast leaves the chart's projection absent, never blanks the observed data.

Pure logic sits in `scripts/lib.js` next to `extractForecast`/`buildRow`
(tested in `test/lib.test.js`); the one browser-side pure helper sits in
`src/data.js` next to `mapRow`/`toSeriesPairs` (tested in `test/data.test.js`).

## The model

A physically-motivated **relaxation model** — water relaxes toward air
temperature, modified by wind mixing:

```
dWater/dt  =  a·(air − water)  +  b·wind_speed  +  c
```

### Fit — `fitRelaxation(readings)` (pure, in `lib.js`)

Between each consecutive reading pair `(i, i+1)`:

- `Δt` = `(epoch[i+1] − epoch[i]) / 3600` hours,
- observed rate `r = (water[i+1] − water[i]) / Δt`,
- predictors `x = ( air[i] − water[i], wind_speed[i], 1 )`.

Fit `r ≈ a·x₁ + b·x₂ + c` by **ordinary least squares over 3 unknowns**, solved
directly from the 3×3 normal equations by Gaussian elimination — no library, no
dependency.

**Usable-pair guards** (a pair is skipped unless all hold):

- `MIN_GAP_S ≤ Δt·3600 ≤ MAX_GAP_S` (default ~5 min to ~90 min) — excludes feed
  interruptions where the instantaneous-rate approximation breaks down.
- `water[i]`, `water[i+1]`, `air[i]`, and `wind_speed[i]` all non-null.

Returns `{ a, b, c, n, ok }` where `n` is the usable-pair count and `ok` is
false when `n < MIN_PAIRS` (default ~50) or the fit is non-physical (`a ≤ 0`, or
any coefficient non-finite). `ok: false` triggers the persistence fallback
(below).

**History window:** ~30 days (`FIT_WINDOW_DAYS = 30`). Long enough for a stable
3-parameter fit at this cadence (~2000 readings), short enough that the fit
tracks the current season rather than averaging across it.

### Roll forward — inside `buildProjection(...)` (pure, in `lib.js`)

Seed at the latest actual reading `W₀` at time `t₀`. Step along met.no's hourly
forecast timestamps `t₀ < t₁ < t₂ … ≤ t₀+48h`:

```
W(k+1) = W(k) + Δt·( a·(air[k] − W(k)) + b·wind[k] + c )
```

Because each step relaxes toward that hour's *forecast* air temperature, the
integration self-corrects and stays numerically stable. The result is the array
of projected `{ epoch, water }` points.

## Trust: backtest → confidence band

We cannot archive past *forecasts*, so we measure **model error** by walk-forward
backtest over the fit history — `backtestError(readings, coeffs, horizons)`
(pure, in `lib.js`):

- From many past origin points (spaced across the history), roll the fitted
  model forward using the **actually observed** later air/wind as the driver.
- Compare each prediction against the real water reading nearest each horizon
  (`+6h, +12h, +24h, +48h`) and accumulate the mean absolute error per horizon.

This yields an empirical error curve `err(h)` that grows with horizon. The
**band** at horizon `h` is:

```
lower/upper = W_pred(h) ∓ INFLATE · err(h)
```

so it widens naturally with distance. `err(h)` at intermediate hours is linearly
interpolated between the measured horizons.

**Honest caveat (baked into the design):** the backtest feeds *actual* air/wind,
not a forecast, so it captures model error but **not** met.no's own air/wind
forecast error — it is therefore slightly optimistic. We multiply the band by a
fixed `INFLATE = 1.3` to partially account for this, and the spec/comment states
plainly that the band is an approximation, not a calibrated prediction interval.

## Fallback & guardrails

When `fitRelaxation` returns `ok: false` (too few usable pairs, or a
non-physical fit), fall back to **flat persistence** at `W₀` — a defensible
baseline — with the band still drawn from `backtestError` (which itself falls
back to the observed water variance over the horizon when the model can't be
fit). The payload records `model: "persistence"` vs `model: "relaxation"` so the
active method is transparent to anyone inspecting the row. With the month-plus of
history already collected, the relaxation path is expected to be the normal case.

## Storage — new `forecast` table

One row per location, **replaced** on every poll:

```sql
create table if not exists forecast (
  location_id  text primary key,
  generated_at timestamptz not null,
  payload      jsonb not null
);
-- payload shape:
-- { horizonH: 48,
--   model: "relaxation" | "persistence",
--   coeffs: { a, b, c } | null,
--   backtest: { mae6, mae12, mae24, mae48 },
--   points: [ { epoch, water, lower, upper }, ... ] }

alter table forecast enable row level security;
create policy "Public read access" on forecast
  for select to anon using (true);
```

The poller upserts with `Prefer: resolution=merge-duplicates` (ON CONFLICT DO
UPDATE) — a **replace** pattern, deliberately distinct from the append-only
`readings` invariant and confined to its own table, so it does not touch that
invariant. Reads are public to `anon` exactly like `readings`; writes use the
existing `SUPABASE_SERVICE_KEY`. No new secret.

## Browser rendering

- **`app.js`:** add a third parallel fetch — `loadForecast` — alongside
  `loadLatest`/`loadData` in `refresh`, hitting the `forecast` row for the
  location. Fails soft: a transient error leaves the existing chart intact and
  simply omits the projection. Runs each `refresh`, so the projection tracks the
  freshest stored row.
- **`src/data.js`:** pure `mapForecast(payload)` → `{ line, lower, band }` series
  data:
  - `line` — dashed `[ms, water]` pairs in the water-series color.
  - band — the standard ECharts confidence-band trick: a transparent `lower`
    line series plus a semi-transparent area series stacked from `lower` up to
    `upper − lower`, so the shaded region spans `[lower, upper]`.
  Unit-tested in `test/data.test.js`.
- **Visibility:** shown whenever a `forecast` row exists. Every range already
  pins the right edge to *now*, so the 48h projection always sits at the right
  edge — the headline on 24h/7d, a small sliver on 30d/all. No new toggle.

## Config knobs (new)

Constants grouped in `scripts/lib.js` (or `poll.js` where they gate I/O):

- `FIT_WINDOW_DAYS = 30` — history window queried for the fit.
- `MIN_GAP_S` / `MAX_GAP_S` — usable-pair gap bounds (~300 / ~5400 s).
- `MIN_PAIRS = 50` — minimum usable pairs before the fit is trusted.
- `HORIZON_H = 48` — projection horizon.
- `INFLATE = 1.3` — band inflation factor for forecast-input error.

## Testing (TDD)

Tests are written first, per `test-driven-development`:

- `fitRelaxation` recovers known `a, b, c` (within tolerance) from synthetic
  readings generated by the model itself; returns `ok: false` on too-few pairs
  and on a non-physical fit.
- `rollForward`/`buildProjection` is deterministic and self-corrects (a
  perturbed seed converges toward the air-driven trajectory).
- `backtestError` returns a monotone-ish, non-negative error per horizon on
  synthetic data, and falls back gracefully when the model can't be fit.
- `extractForecastSeries` reads hours 1..48 (air + wind) from a met.no fixture,
  ignoring hour 0, and tolerates the mid-range switch from hourly to 6-hourly
  entries.
- `mapForecast` (browser) produces the dashed line pairs and the
  lower/band series with the correct stacking offsets.

Run `npm test` (node --test, zero deps) — new server tests in
`test/lib.test.js`, browser test in `test/data.test.js`.

## Out of scope

- Archiving past forecasts to verify real (forecast-input) error over time — the
  band uses a model-error backtest with an inflation factor instead.
- Horizons beyond 48h, or per-day/tabular forecast readouts.
- Any ML / dependency — the model is closed-form OLS solved in-repo.
- Multi-location forecasting — only Dulpen (`STORAGE_ID = "0-10238"`) is written,
  though the `forecast` table is keyed by `location_id` for future spots.
- Changing the observed-data path, the `readings` schema, or the append-only
  invariant.
