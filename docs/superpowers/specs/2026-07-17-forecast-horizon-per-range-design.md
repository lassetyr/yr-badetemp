# Design: Per-range forecast horizon

**Date:** 2026-07-17
**Status:** Approved — ready to plan
**Branch:** `feat/forecast-horizon-per-range`

## Problem

The 48-hour projection is always drawn in full, regardless of the selected time
range. On the **24t** view this squeezes the observed data into the left third
while the 48h forecast fills the right two-thirds — the actual measurements
become an afterthought. Wider ranges (7d/30d/all) don't have this problem: 48h is
a small fraction of their window.

## Goal

Trim how much of the projection is *drawn* per selected range, so the observed
data keeps a sensible share of the chart. Only the display changes — the stored
and fetched projection stays the full 48h (the wider views still draw all of it).

## Decision: per-range horizon caps (settled during brainstorming)

Underlying rule: show forecast ≈ half the observed window, capped at the 48h we
have. In practice only 24t is trimmed:

| Range | Forecast shown |
|-------|----------------|
| 24t   | 12h            |
| 7d    | 48h (full)     |
| 30d   | 48h (full)     |
| Alle  | 48h (full)     |

## Architecture

Display-only clamp. No change to `poll.js`, `scripts/lib.js`, the `forecast`
table, or the browser's fetch — the full 48h projection is stored, fetched, and
held in the `forecast` module variable exactly as today. The trim happens at
render time, keyed by the selected range.

- **Policy — `app.js`.** A map alongside the existing UI thresholds
  (`STALE_THRESHOLD_SEC`, `TREND_SAMPLE`):

  ```js
  const FORECAST_HORIZON_H = { "24h": 12, "7d": 48, "30d": 48, "all": 48 };
  ```

  Policy lives in `app.js`, per the convention that `src/data.js` stays free of
  it.

- **Pure helper — `src/data.js`.** `clampForecast(forecast, nowEpochSec,
  maxHorizonH)` returns a new `{ line, lower, band }` keeping only the pairs at
  or before `(nowEpochSec + maxHorizonH * 3600) * 1000` ms, or `null` when the
  input is null/empty or nothing survives. Pure and unit-tested in
  `test/data.test.js`, next to `mapForecast`.

- **Wiring — `buildOption` in `app.js`.** Resolve `FORECAST_HORIZON_H[rangeKey]`
  (default `48`), clamp the module `forecast` once, and use the *clamped* result
  for both the drawn series and the axis right-edge (`fcMaxMs`). So on 24t the
  axis becomes ≈ `[now − 24h, now + 12h]` instead of stretching to +48h.

## Details & edge cases

- **Anchor is now.** The cap is measured from `nowEpochSec` (which `buildOption`
  already receives and which the axis right-edge uses), so "12h ahead" means 12h
  ahead of the current time, consistent with the pinned right edge.
- **Seed is retained.** `points[0]` (the seed at ≈now, with a zero-width band) is
  always ≤ `now + cap`, so it survives every clamp — the dashed line still joins
  the solid line and the band still opens from zero width.
- **Empty result.** If `clampForecast` returns `null` (no forecast, or nothing
  within the horizon), `buildOption` draws no projection and leaves the axis max
  at the range's own bound (`bounds.max` = now), exactly as when no forecast
  exists.
- **Staleness unchanged.** The existing `FORECAST_STALE_SEC` drop in
  `loadForecast` still runs first; clamping only ever narrows an
  already-fresh-and-present forecast.

## Testing (TDD)

Unit tests for `clampForecast` in `test/data.test.js`:

- Keeps points at/within the horizon and drops those beyond it.
- Retains the seed point (first point at ≈now) under a small horizon.
- Returns `null` for a null/empty forecast, and for a horizon that excludes
  everything.
- Clamps `line`, `lower`, and `band` consistently (same set of timestamps
  across all three).

`npm test` stays green; no server-side tests change.

## Out of scope

- Any change to what the poller computes or stores (still the full 48h).
- Making the caps user-configurable in the UI.
- Changing the confidence-band math or the projection model.
