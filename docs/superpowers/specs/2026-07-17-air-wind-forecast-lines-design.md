# Design: Air & wind forecast lines

**Date:** 2026-07-17
**Status:** Approved — ready to plan
**Branch:** `feat/air-wind-forecast-lines`

## Problem

The chart draws a dashed **water** projection, but the met.no air and wind
*forecasts* that already drive it are discarded after the projection is built.
Users see where the water is heading but not the air/wind that will get it there.
We want forward dashed lines for Luft and Vind too.

Constraint the user flagged: observed **Vind** is already a dashed line, so a
dashed forecast for it would collide. This spec resolves that with a single
chart-wide convention.

## Goal

Draw forward forecast lines for air (Luft) and wind (Vind) alongside the existing
water projection, under one legible convention: **solid = measured, dashed =
forecast**. Reuse the per-range horizon caps and the existing fail-soft/staleness
plumbing. The air/wind forecasts come straight from met.no, so they get **no**
confidence band (unlike the modelled water projection).

## Decisions (settled during brainstorming)

- **Scope:** both air and wind forecast lines.
- **Styling convention:** observed = solid, forecast = dashed. Observed **Vind**
  is restyled from dashed to a **thin solid gray** line (1.5px). Luft/Vind
  forecasts are dashed in their series colors.
- **No band** on air/wind forecasts (met.no values, not a modelled projection).
- **Horizon:** reuse `FORECAST_HORIZON_H` + `clampForecast` (24t → 12h;
  7d/30d/all → full 48h) — the new lines trim exactly like the water projection.
- **Legend coupling:** each forecast line renders only when its observed
  counterpart is enabled in the legend. Applied to all three (water, air, wind),
  which also removes the current quirk where the water projection ignores the
  Vann toggle.
- **Wind-direction arrow:** the forecast Vind tooltip shows the same direction
  arrow as observed Vind, so we store `windDir` per forecast point.

## Architecture & data flow

Payload-content + rendering feature. The met.no forecast is *already fetched*
every poll and used to roll the water projection forward, so the air/wind values
are in hand at build time — we persist them onto each projection point. No schema
migration (`forecast.payload` is `jsonb`); the only server-side touch is one
extra column in the poller's history query (for the seed's wind direction).

- **Poller — `scripts/poll.js`.** `fetchHistory` adds `wind_dir` to its `select`
  and maps it to `windDir` (it already fetches `air`/`wind_speed`). This is so the
  **seed** point can carry the last observed wind direction. No other poller
  change.

- **Pure model — `scripts/lib.js`.**
  - `extractForecastSeries` also pulls `wind_from_direction` from the met.no
    `instant.details`, returning `{ epoch, air, windSpeed, windDir }` per entry
    (`windDir` may be null).
  - `buildProjection` attaches `air`, `windSpeed`, `windDir` to each projection
    point by looking them up from the forecast series by epoch. The seed point
    (`points[0]`, at ≈now) takes `air`/`windSpeed`/`windDir` from the last
    history reading, so the dashed forecast lines begin exactly where the solid
    observed lines end. Point shape becomes:

    ```
    { epoch, water, lower, upper, air, windSpeed, windDir }
    ```

- **Pure browser — `src/data.js`.**
  - `mapForecast` gains `airLine` (`[ms, air]` pairs) and `windLine`
    (`[ms, windSpeed, windDir]` pairs — the bearing rides as a third element the
    line series ignores but the tooltip reads). A null `air`/`windSpeed` passes
    through as the pair value so the line breaks rather than lying.
  - `clampForecast` also trims `airLine` and `windLine` to the horizon. It
    filters by the first element (`ms`), so `windLine`'s third element is
    untouched. Guards each array with optional access so a water-only object
    (no `airLine`/`windLine`) still clamps cleanly.

- **Rendering/DOM — `app.js`.**
  - Observed **Vind** series: `lineStyle.type` changes from `"dashed"` to solid
    (drop the `type`), width unchanged (1.5px, gray `#94a3b8`).
  - Two new forecast series inside the existing `...(fc ? [...] : [])` spread:
    - **Luft (prognose):** dashed amber (`#f59e0b`), `yAxisIndex: 0`, `data: fc.airLine`.
    - **Vind (prognose):** dashed gray (`#94a3b8`), `yAxisIndex: 1`, `data: fc.windLine`.
    Both `showSymbol: false`.
  - `SERIES_UNIT` gains `"Luft (prognose)": "°C"` and `"Vind (prognose)": "m/s"`.
  - Tooltip: the two new series show values with units like the others (the
    existing `_`-prefixed band helpers stay filtered out). The Vind-forecast row
    appends `degToArrow(s.value?.[2])` — the bearing packed in element 2 — mirroring
    how observed Vind appends `degToArrow(byMs.get(...)?.windDir)`.
  - **Legend coupling:** in `buildOption`, each forecast series is included only
    when its observed counterpart is on: gate the water/air series on
    `legendSelected?.Vann !== false` / `legendSelected?.Luft !== false` and the
    wind series on `legendSelected?.Vind !== false`. `legendSelected` undefined
    (all on) → all shown.

## Details & edge cases

- **Connection to observed lines.** The seed point carries the last observed
  air/windSpeed/windDir, so each dashed forecast line starts at the solid line's
  tip — no gap. (Same mechanism the water dashed line already uses.)
- **Nulls.** met.no or a history reading may lack a field; it passes through as a
  null pair value (line breaks) rather than fabricating a point. The direction
  arrow shows `-` when the bearing is null (existing `degToArrow` behavior).
- **Horizon + staleness + fail-soft:** unchanged. The new lines ride the same
  clamped, staleness-checked, fail-soft `forecast` object; nothing new to fetch
  or guard in `loadForecast`.
- **Direction semantics.** `windDir` is met.no's meteorological bearing (wind
  *from*), identical to what `readings.wind_dir` stores; `degToArrow` already
  converts it to a "blows toward" arrow, so observed and forecast arrows match.

## Testing (TDD)

Pure helpers, unit-tested:

- `extractForecastSeries`: entries include `windDir` from `wind_from_direction`;
  null when absent.
- `buildProjection`: each point carries `air`/`windSpeed`/`windDir`; the seed
  carries the last history reading's air/windSpeed/windDir.
- `mapForecast`: `airLine` is `[ms, air]`; `windLine` is `[ms, windSpeed, windDir]`.
- `clampForecast`: trims `airLine`/`windLine` to the horizon alongside
  `line/lower/band`; a water-only object still clamps.

`app.js` styling (solid Vind, dashed forecast lines, tooltip arrow, legend
coupling) is verified in the browser — deferred to the human. `npm test` stays
green.

## Out of scope

- Confidence bands on the air/wind forecasts.
- Wind gust in the forecast (only speed + direction, matching what the tooltip
  needs).
- Any change to the water projection model, the schema, or the poll cadence.
- Making forecast horizons user-configurable.
