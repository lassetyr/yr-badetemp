# Design: Glanceability enrichments (stale badge, trend, comfort line, dataZoom, richer tooltip, stats row)

**Date:** 2026-06-29
**Status:** Approved
**Branch:** `feat/chart-glanceability` (off `main`)

## Problem

The page shows the current temperature and a faithful time-axis chart, but a
visitor can't tell at a glance:

- whether the "current" reading is actually current or hours stale,
- whether the water is warming or cooling versus yesterday,
- how this reading compares to a comfortable swimming temperature,
- the min/max/average across the window they're looking at.

The wind **gust** and **direction** are already fetched (`wind_gust`,
`wind_dir`, surfaced as `windGust` / `windDir` by `mapRow`) but never shown.
And the chart can't be zoomed/panned within a range.

This adds six small enrichments without touching the backend, data layer, or
ranges. Everything computed lives as pure, unit-tested helpers in
[src/data.js](src/data.js); all DOM/ECharts wiring stays in [app.js](app.js),
matching the existing I/O-free seam.

## Goals

1. **Stale badge** — when the latest reading is older than **2 h**, mark the
   header "oppdatert …" line as stale (amber tint + "⚠ utdatert"), and always
   append a human age ("12 min" / "3 t" / "2 d") to that line.
2. **Trend arrow** — next to the big temperature, show ▲/▼ and a signed delta
   for the change across the **selected period** (so it follows the range
   selector); hidden when there's too little data to compare.
3. **Comfort reference line** — a faint `markLine` on the water series at
   **18 °C** labelled "behagelig".
4. **dataZoom on all ranges** — inside (scroll/drag) + a dark slider, so any
   window can be zoomed/panned.
5. **Richer tooltip** — every row shows its value with a Norwegian-comma number
   and a unit (`°C` / `m/s`); the "Vind" row also gains a direction arrow,
   e.g. `Vind: 0,8 m/s →` (`-` when the direction is unknown).
6. **Range stats row** — a muted row under the chart: `min 14,2° · maks 17,8°
   · snitt 16,1°`, recomputed per selected range; hidden when empty.

Non-goals: backend / poller / Supabase changes, new ranges, changing series
colors, refresh cadence, or the data-layer query (gust/direction already
arrive).

## New pure helpers in `src/data.js` (each TDD-tested)

All take plain data and return plain data — no DOM, no `Date.now()`. Thresholds
are passed in by the caller (they're UI config, see below).

- `waterStats(readings)` → `{ min, max, avg } | null`
  - Over the non-null `water` values in `readings`. `null` when there are none.
  - `avg` is the arithmetic mean of those values (not rounded here; formatting
    happens in `app.js`). Powers the stats row.

- `isStale(latestEpoch, nowEpoch, thresholdSec)` → `boolean`
  - `true` when `nowEpoch - latestEpoch > thresholdSec`. `latestEpoch` in
    seconds (the row's `epoch`). Null/undefined `latestEpoch` → `false`
    (nothing to flag).

- `humanizeAge(seconds)` → Norwegian short age string
  - `< 60 min` → `"<n> min"`; `< 24 h` → `"<n> t"`; else `"<n> d"`.
  - Floored integers. Negative/`null` input → `"0 min"` (clock-skew guard).

- `degToArrow(deg)` → one of `"↑","↗","→","↘","↓","↙","←","↖"` or `null`
  - 8-point arrow for the direction the wind blows TOWARD. Input is the
    meteorological source bearing (where the wind comes from), so the arrow is
    180° opposite: 225° (from SW) → `↗` (blows NE). `null`/non-finite → `null`.
    Boundary at the midpoints
    (e.g. 0/360 → "N", 45 → "NØ", 337.5..360 wraps back to "N").

- `waterTrend(readings, sampleSize)` → `{ delta, direction } | null`
  - Net change across the supplied `readings` (the selected range): the mean of
    the **last** `sampleSize` readings minus the mean of the **first**
    `sampleSize`. Averaging both ends smooths single-point noise; the two
    samples never overlap (`sampleSize` is capped at half the usable count, so
    with few readings it narrows to a plain first-vs-last comparison).
  - `delta` = end − start (signed, °C). `direction` = `"up" | "down" | "flat"`
    (`"flat"` when `delta` rounds to 0,0 at one decimal). Readings with `null`
    water are skipped. `null` when fewer than two usable points.
  - `readings` is the oldest-first array already in `allReadings`, so the trend
    automatically reflects whatever range the user has selected (and all history
    for `Alle`). No time/epoch math — it operates on reading order.

### Thresholds (named constants in `app.js`, UI config)

```js
const STALE_THRESHOLD_SEC = 2 * 3600;   // badge trigger
const COMFORT_TEMP = 18;                // reference line °C
const TREND_SAMPLE = 3;                 // readings averaged at each end of the period
```

These stay in `app.js` and are passed into the pure helpers, keeping `data.js`
free of policy.

## Header changes (`updateHeader`, index.html, styles.css)

- **Age + stale.** Append `humanizeAge(nowEpoch() - latest.epoch)` to the
  "oppdatert …" line. When `isStale(latest.epoch, nowEpoch(), STALE_THRESHOLD_SEC)`
  is true, add a `.stale` class to the `.as-of` element (or its wrapper) →
  amber tint + a small "⚠ utdatert" marker; remove the class otherwise.
- **Trend arrow.** A new element next to `#current-temp` showing
  ▲/▼ + signed delta formatted via `Intl.NumberFormat("nb-NO")`, e.g.
  `▲ +0,4°`. Green for `"up"`, red for `"down"`, muted for `"flat"`; the
  element is hidden (`hidden` attr) when `waterTrend` returns `null`. Computed
  from `allReadings` (the chart data, oldest-first), not the single `latest`.
- New static markup in [index.html](index.html): a `#current-trend` span inside
  `.current`. New CSS for `.stale` and the trend colors in
  [styles.css](styles.css), using existing theme vars where possible plus an
  amber accent.

## Chart changes (`buildOption`)

All additive; existing grid/axes/legend/series styling unchanged except the
grid `bottom` grows to make room for the slider.

- **dataZoom** (all ranges): an `inside` zoom (scroll/drag) plus a `slider`
  styled for the dark panel (handle/fill/border using theme grays). Grid
  `bottom` increases from `40` to fit the slider; axis-label legibility kept.
- **Comfort line**: on the Vann series, a `markLine` with a single `yAxis: 18`
  entry, faint style, `label` "behagelig". Silent (no symbol, not in tooltip).
- **Richer tooltip**: build a `Map<ms, reading>` from the passed-in `readings`
  once per `buildOption` call. Each row's value is formatted with a Norwegian
  1-decimal number formatter and a per-series unit (`Vann`/`Luft` → `°C`,
  `Vind` → `m/s`); a `null` value falls back to `–` with no unit. For the Vind
  row, when the wind speed is present, look up the reading by `s.value[0]` (the
  ms timestamp) and append a direction arrow `degToArrow(windDir)` (or `-` when
  the direction is unknown), e.g. `Vind: 0,8 m/s →`.
- **Two fixes folded in:**
  - Guard the tooltip formatter against empty/missing `params`
    (`if (!params || !params.length) return ""`).
  - Rename the `buildOption` parameter that shadows the module-level `nowEpoch`
    function from `nowEpoch` → `nowEpochSec` (it's the seconds value passed by
    `render`); update `rangeBounds(rangeKey, nowEpochSec)` accordingly.
- **Reduced motion**: when `matchMedia("(prefers-reduced-motion: reduce)")`
  matches, set `animation: false` in the option.

## Stats row + responsiveness (index.html, styles.css)

- A muted `#stats` element under the chart in [index.html](index.html). In
  `render`, compute `waterStats(allReadings)` and write
  `min <x>° · maks <y>° · snitt <z>°` using `Intl.NumberFormat("nb-NO",
  { minimumFractionDigits: 1, maximumFractionDigits: 1 })`. Hidden (`hidden`
  attr) when `waterStats` is `null` (e.g. empty range). Recomputed every render,
  so it tracks the selected range.
- **Media query** (narrow screens): reduce `.chart` height, let `.header` /
  stats wrap. Honor `prefers-reduced-motion` in CSS too (e.g. disable any
  transitions added for the trend/stale states).

## Data flow

```
loadData() → allReadings = rows.map(mapRow).reverse()   // oldest-first (unchanged)
loadLatest() → latest = mapRow(rows[0])                 // newest (unchanged)

render():
  buildOption(allReadings, currentRange, nowEpoch())    // + dataZoom, markLine,
                                                         //   tooltip map, reduced motion
  #stats ← waterStats(allReadings)

updateHeader():
  age   ← humanizeAge(nowEpoch() - latest.epoch)
  stale ← isStale(latest.epoch, nowEpoch(), STALE_THRESHOLD_SEC)
  trend ← waterTrend(allReadings, TREND_SAMPLE)
```

`updateHeader` currently runs only from `loadLatest`; the trend depends on
`allReadings`, so `render` (or `loadData`) must also refresh the header's trend
(call `updateHeader` after `allReadings` updates). Keep `latest` as the source
of the big temperature and as-of time; use `allReadings` only for the trend.

## Components & responsibilities

- `src/data.js` (pure): gains `waterStats`, `isStale`, `humanizeAge`,
  `degToArrow`, `waterTrend`. Existing exports unchanged.
- `app.js`: thresholds constants; `buildOption` (dataZoom, comfort markLine,
  enriched tooltip with per-series units + direction arrow, empty-params guard, `nowEpoch`→
  `nowEpochSec` rename, reduced-motion); `updateHeader` (age + stale + trend);
  `render` (stats row, header refresh).
- `index.html`: `#current-trend` span, `#stats` element.
- `styles.css`: `.stale`, trend colors, dark dataZoom-adjacent spacing, stats
  row, responsive + reduced-motion media queries.
- `test/data.test.js`: new unit tests for the five helpers.

## Testing

Unit tests (`node --test`, zero deps) in [test/data.test.js](test/data.test.js):

- `waterStats`: mixed values → correct min/max/avg; all-null water → `null`;
  empty array → `null`; single reading → min=max=avg.
- `isStale`: just under / just over threshold; exactly at threshold (not stale,
  strict `>`); null `latestEpoch` → `false`.
- `humanizeAge`: `min` / `t` / `d` unit boundaries (59 min, 60 min→1 t, 23 h,
  24 h→1 d); negative/null → `"0 min"`.
- `degToArrow`: each of the 8 sectors incl. the N (`↑`) wrap (0, 360, 359),
  boundaries `↑`/`↗` (e.g. 22.5, 45), null/NaN → `null`.
- `waterTrend`: warming and cooling deltas with correct sign/direction over the
  smoothed ends; a single end spike is dampened by averaging; `sampleSize`
  capped at half the readings (no overlap); null water skipped; fewer than two
  usable readings → `null`; delta ≈ 0 → `"flat"`.

Visual verification (serve the page): stale badge appears when the latest
reading is old; trend arrow reflects the selected range (changes when you switch
24t/7d/30d/Alle) and hides with too little data; 18° line labelled
"behagelig"; slider zooms/pans on every range; Vind tooltip shows a direction
arrow; stats row matches the selected range and uses Norwegian commas;
narrow-viewport layout wraps; animations off under reduced-motion. `buildOption`
and DOM remain visually verified, as before.

## Decisions (not open questions)

- Stale threshold **2 h**, comfort temp **18 °C**, trend sample **3 readings**
  per end — all named constants in `app.js`.
- dataZoom on **all** ranges (inside + dark slider).
- Stats render as a **muted row under the chart**, recomputed per range, hidden
  when empty.
- Trend is computed from `allReadings` (the selected range) as the smoothed
  net change from the start of the period to now; hidden with too little data.
- Compass is 8-point, Norwegian abbreviations (N/NØ/Ø/SØ/S/SV/V/NV).
- Empty-`params` tooltip guard and `nowEpoch`→`nowEpochSec` rename folded into
  this change.

## Out of scope

- Backend / poller / Supabase / schema changes.
- Adding or changing ranges.
- New series, color changes, or legend behavior.
- Interpolating or back-filling missing readings.
