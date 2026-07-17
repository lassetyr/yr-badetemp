# Design: mean-air-coupled water projection

**Date:** 2026-07-17
**Status:** Approved — ready to plan
**Branch:** `feat/mean-air-forecast-model`

## Problem

The 48h water projection under-reacts to forecasted multi-day air changes. On a
day when met.no forecasts air collapsing from ~27°C to ~13°C, the water line
stays almost flat. Investigation of the live model (fitted `a ≈ 0.0057 /h`,
`c ≈ +0.043 °C/h`) found two causes:

1. **Diluted air coupling.** The model fits the *instantaneous* rate over
   20–90 min reading pairs against `(air − water)`. On that timescale air swings
   ±5°C daily but water physically can't follow, so ordinary least squares sees
   huge regressor variance with almost no response and attenuates `a` toward zero
   (regression dilution). The result is a time constant `τ = 1/a ≈ 5–7 days`, so
   water crawls even when air makes a sustained multi-day move.
2. **Spurious warming drift.** The intercept `c ≈ +0.043 °C/h` bakes ~+2°C of
   pure warming over 48h into the roll-forward — a summer-seasonal trend captured
   from the fit window and extrapolated as if it were causal.

A prototype (backtested with the code's own walk-forward `backtestError`) showed
that **coupling to the 24-hour running-mean air instead of instantaneous air** is
the lever that restores a physically honest response: it removes the diurnal
noise dragging `a` down, yielding `τ ≈ 1.5 days`, so a *sustained* air drop pulls
water down visibly while the daily wobble is still ignored. Dropping `c` on top
keeps the smoothed fit stable (with `c` retained the smoothed fit overfit to a
−0.14 °C/h cooling drift).

### Prototype evidence (11-day live window, this scenario)

Simulated water trajectory for the flagged scenario (air 27 → 13 → 18 over 48h):

| model | now | +12h | +24h | +48h |
|---|---|---|---|---|
| current (inst air, c=+0.034) | 20.8 | 20.7 | 19.8 | 18.9 |
| drop c (inst air, c=0) | 20.8 | 20.6 | 19.9 | 19.0 |
| **mean-air driver (24h-smoothed, c=0)** | 20.8 | 20.5 | 18.9 | **15.8** |

Walk-forward backtest MAE (°C) over the same window:

| model | MAE6 | MAE12 | MAE24 | MAE48 |
|---|---|---|---|---|
| persistence (flat) | 0.53 | 0.76 | 0.80 | 1.23 |
| current | 0.48 | 0.68 | 0.61 | 0.85 |
| mean-air (24h, c=0) | 0.50 | 0.64 | 0.70 | 0.89 |

The mean-air model costs ~0.04°C average accuracy at 48h over this **stable**
window (no cold front to reward reactivity), accepted deliberately: the
confidence band — sized from this same backtest — widens to reflect it, and the
window contains none of the front scenarios the change targets.

## Goal

Make the water projection couple to the **24-hour trailing-mean air**
temperature and drop the intercept `c`, so the forecast tracks sustained air
changes while ignoring the diurnal wobble. Keep the confidence band, persistence
fallback, and stored payload shape intact. Separately, fix the history fetch so
the fit actually sees the configured window (it is currently capped at ~11 days).

## Decisions (settled during brainstorming)

- **Driver:** 24-hour trailing-mean air (`SMOOTH_WINDOW_H = 24`), a new tunable
  constant alongside the existing forecast tunables.
- **Intercept:** dropped. `fitRelaxation` fits `a, b` only and reports `c: 0`.
- **Smoothing is internal to the water model only.** The air/wind *lines* the
  browser draws stay the raw met.no forecast — only the model's driver is
  smoothed.
- **Seam continuity:** the roll-forward smooths over history-tail ∪ forecast, so
  the first 24h of forecast averages real observations rather than cold-starting.
- **Row-cap fix included:** `fetchHistory` paginates so the fit uses the full
  `FIT_WINDOW_DAYS` window instead of Supabase's 1000-row read cap (~11 days at
  the current cadence).
- **Payload shape unchanged**, so `app.js`, `src/data.js`, and
  `supabase/schema.sql` are untouched.

## Architecture & data flow

All model changes are in `scripts/lib.js` (pure). The smoothing happens
*upstream* of the existing fit / roll-forward / backtest machinery, which stays
driver-agnostic.

- **New tunable — `scripts/lib.js`.** `export const SMOOTH_WINDOW_H = 24;`.

- **New pure helper — `smoothAirSeries(series, windowH)`.** Input: an
  epoch-ascending array of entries carrying at least `{ epoch, air }` (plus
  optional `water`/`windSpeed`/`windDir`). Output: a new array, same length and
  order, each entry shallow-copied with `air` replaced by the **trailing mean**
  of `air` over `[epoch − windowH·3600, epoch]` (inclusive, over the entries
  present). Entries whose own `air` is null, and null neighbors, are excluded
  from the mean; an entry with no non-null air in its window gets `air: null`.
  All other fields are preserved unchanged. Pure; unit-tested.

- **`fitRelaxation` — fit `a, b`, drop `c`.** The predictor row becomes
  `[air − water, windSpeed]` (no constant column); solve the resulting 2×2 normal
  equations (a `solve2` by Cramer's rule, mirroring `solve3`). Return
  `{ a, b, c: 0, n, ok }`. The `ok` gate is unchanged in spirit: finite `a`, `b`
  and `a > 0`, else `{ a: 0, b: 0, c: 0, n, ok: false }` (persistence). Callers
  pass **already-smoothed** readings (their `.air` is the smoothed value), so
  `fitRelaxation` needs no knowledge of smoothing.

- **`rollForward` and `backtestError` — unchanged code.** They already integrate
  `a·(air − w) + b·windSpeed + c` and scan reading/forecast arrays; with `c = 0`
  and a smoothed `.air` in the arrays they produce the mean-air trajectory. No
  signature or body change.

- **`buildProjection` — the wiring.**
  1. `smoothHist = smoothAirSeries(history, SMOOTH_WINDOW_H)` → used for both
     `fitRelaxation(smoothHist)` and `backtestError(smoothHist, coeffs)`.
  2. Build the roll-forward driver by smoothing across the seam: concatenate the
     tail of `history` (those readings within `SMOOTH_WINDOW_H` before the seed,
     projected to `{ epoch, air }`) with `forecastSeries`, sort ascending by
     epoch, `smoothAirSeries(...)`, then keep only the entries with
     `epoch > seed.epoch` — a `smoothedForecast` whose `air` is the smoothed
     driver and whose `windSpeed` rides along from `forecastSeries`. Pass that to
     `rollForward`.
  3. The `weather` map that stamps each point's displayed `air`/`windSpeed`/
     `windDir` continues to read from the **raw** `forecastSeries` (unchanged), so
     the browser still shows real forecast air/wind.
  4. `model`, `coeffs`, `backtest`, band sizing, and `points` shape are all
     unchanged. `coeffs` now carries `c: 0` when `ok`.

- **Poller — `scripts/poll.js`, `fetchHistory` pagination.** Replace the single
  capped read with a paginated fetch (PostgREST `Range` headers, or repeated
  `offset`/`limit`) that pulls all rows within `FIT_WINDOW_DAYS` of now, ordered
  and reversed to ascending as today. No new columns; `air`/`wind_speed`/
  `wind_dir` are already selected. Bounded by `FIT_WINDOW_DAYS` so the fetch can't
  grow without limit.

## Details & edge cases

- **Thin history at the seam.** If fewer than `SMOOTH_WINDOW_H` hours of history
  precede the seed, the seam smoothing averages whatever is in-window — the early
  forecast is simply less smoothed. Graceful; no special case.
- **Nulls.** `smoothAirSeries` passes through `air: null` when a window has no
  non-null air. The existing fit/roll-forward guards already skip pairs/steps
  with null air, so behavior is unchanged.
- **Persistence fallback.** When `fitRelaxation` returns `ok: false` (too few
  pairs, singular system, or `a ≤ 0`), coeffs are all zero and the projection is
  a flat persistence line, exactly as today. `model: "persistence"`.
- **Band.** Sized from `backtestError` on the new model × `INFLATE`; no formula
  change — it simply reflects the new (slightly larger) errors.
- **Payload compatibility.** Points remain
  `{ epoch, water, lower, upper, air, windSpeed, windDir }`; `air`/`windSpeed`/
  `windDir` are the raw forecast values. The browser and schema are untouched.

## Testing (TDD)

Pure helpers in `scripts/lib.js`, unit-tested in `test/lib.test.js`:

- **`smoothAirSeries`:** trailing mean over the window (a hand-computed case);
  window boundary is inclusive; other fields preserved; a null-air entry and
  a window with no non-null air yield `air: null`; a single-element series
  returns its own air.
- **`fitRelaxation`:** on a synthetic series generated from known `a, b`
  (with `c = 0`), recovers `a, b` and reports `c: 0`; a degenerate/too-short
  series returns `ok: false` with zero coeffs; a non-physical `a ≤ 0` fit gates
  to persistence.
- **`buildProjection`:** the roll-forward is driven by *smoothed* air — a
  scenario where instantaneous and smoothed air diverge produces the
  smoothed-driven trajectory (distinguishable from an instantaneous-air roll);
  the seam driver includes the history tail (the first forecast point's smoothed
  air reflects recent observations, not just the first forecast value);
  `coeffs.c` is 0 when `ok`; the displayed `air`/`windSpeed` on points remain the
  raw forecast values.

Existing tests that assert the old 3-parameter fit (non-zero `c`) or the old
coefficient shape are updated to the new `a, b, c: 0` contract — expected churn,
not new behavior. `npm test` stays green.

`scripts/poll.js` pagination is I/O and is verified by a live poll run (deferred
to the human): confirm the fetched history spans ~`FIT_WINDOW_DAYS`, not ~11
days, and that a projection is still produced.

## Out of scope

- Any change to `app.js`, `src/data.js`, `index.html`, or `supabase/schema.sql`
  (payload shape is preserved).
- Adding solar-radiation or humidity inputs to the model.
- Making the smoothing window or time constant user-configurable in the UI.
- Changing the confidence-band formula, the horizon, or the per-range display
  clamp.
- Changing the poll cadence.
