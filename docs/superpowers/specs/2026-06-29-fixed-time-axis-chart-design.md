# Design: Fixed time-axis chart with gap breaks

**Date:** 2026-06-29
**Status:** Approved
**Branch:** `feat/frontend-updates` (off `main`)

## Problem

The chart's x-axis is `type: "category"` (`app.js:82-84`) with the timestamps as
category labels. A category axis spaces every reading **evenly by position**,
ignoring real elapsed time. Consequences:

- A 20-minute gap and a 6-hour gap between readings look identical.
- If the feed goes stale, the line simply ends at the last reading with no
  visual indication that data has stopped arriving.

We want the chart to read as a fixed time window (last 24h / 7d / 30d) so that
elapsed time is shown faithfully: gaps in data appear as gaps in time, and a
stale feed shows an empty stretch up to "now".

## Goals

1. Position points by real time, not by index.
2. Pin the visible window to the selected range, with the **right edge at the
   current time** — so a stale feed shows a growing empty gap on the right.
3. Break the line across **large gaps** (> 6 hours) so missing periods read as
   "no data" rather than a misleading straight segment.
4. Keep an **isolated reading** (one with a break on both sides) visible as a dot.

Non-goals: changing the data layer, the backend, the ranges themselves, the
series/colors, legend persistence, refresh cadence, or the header.

## Approach

### 1. x-axis: category → time

Change `xAxis.type` to `"time"` and set explicit bounds per selected range:

- **24h / 7d / 30d:** `max = now` (ms), `min = now − rangeMs`.
- **all:** `max = now`, `min` left unset (ECharts auto-fits the earliest reading).

`now` is the same wall-clock used elsewhere (`Date.now()`), in milliseconds.

### 2. Series data: `[timestamp, value]` pairs

A time axis requires `[ms, value]` pairs rather than the current parallel arrays
(`readings.map(r => r.water)`). Each of the three series (Vann/Luft/Vind) is
built from pairs. This also enables inserting explicit breaks.

### 3. Gap-breaking + isolated dots

Add two pure helpers to `src/data.js` (keeping logic out of `app.js`, matching
the existing I/O-free seam, and unit-testable):

- `toSeriesPairs(readings, key, gapBreakMs)` → array of items. Walks the
  oldest-first readings and, for each, emits `[ms, reading[key]]`. Between two
  consecutive readings whose timestamps differ by **more than `gapBreakMs`**, it
  inserts a single break item `[ms, null]` (positioned between them) so ECharts
  splits the line there. `ms` is derived from each reading's `epoch`
  (`epoch * 1000`) — `epoch` is already seconds in the row shape.
  - A reading whose `key` value is itself `null` (e.g. `air`/`windSpeed` on a
    water-only row) yields `[ms, null]`, which correctly breaks that one series
    at that point — same behavior the category axis produced via a null y-value.
- `rangeBounds(rangeKey, nowEpoch)` → `{ min, max }` in **ms**: `max = nowEpoch
  * 1000`; for a known range `min = (nowEpoch − rangeSeconds) * 1000`; for `all`
  (or unknown) `min = undefined`. Reuses the existing `RANGE_SECONDS` map in
  `src/data.js`.

New tunable constant in `src/data.js`: `GAP_BREAK_MS = 6 * 3600 * 1000`.

**Line break mechanism:** ECharts line series default `connectNulls: false`, so a
`null` data value splits the line (confirmed against ECharts docs). We keep
`connectNulls` at its default (do not set it true). **Isolated-point dots:**
ECharts renders the symbol for a data point whose neighbors are null even when
`showSymbol: false`, so the dot for an isolated reading comes for free from the
same break. The implementation will verify this visually; if it ever fails to
hold, the fallback is a small `scatter` overlay series of the isolated points.

### 4. Formatter adjustments in `buildOption` (app.js)

A time axis changes the value type handed to formatters:

- **Axis label** (`xAxis.axisLabel.formatter`): now receives a ms timestamp.
  `osloParts(value, …)` already does `new Date(value)`, which accepts a ms
  number, so the Oslo (`Europe/Oslo`) formatting is preserved unchanged.
- **Tooltip header** (`tooltip.formatter`): `params[0].axisValue` is now a ms
  timestamp; `osloParts` handles it the same way.
- **Tooltip rows:** each `s.value` is now a `[ms, value]` pair, so the value
  shown changes from `s.value` to `s.value[1] ?? "–"`.

`xAxis.min` / `xAxis.max` are set from `rangeBounds`. Everything else in
`buildOption` (grid, dual y-axes, legend, series styling/colors, smoothing) is
unchanged. `buildOption` will need access to the current range and `now` to
compute bounds — passed in as arguments rather than read from module globals.

## Data flow

```
loadData() fetches rows (unchanged)
  → allReadings = rows.map(mapRow).reverse()   // oldest-first (unchanged)
  → render() → buildOption(allReadings, currentRange, nowEpoch())
        ├─ xAxis: { type: "time", ...rangeBounds(currentRange, nowEpoch) }
        └─ series[i].data = toSeriesPairs(allReadings, key_i, GAP_BREAK_MS)
```

## Components & responsibilities

- `src/data.js` (pure): gains `GAP_BREAK_MS`, `toSeriesPairs`, `rangeBounds`.
  Existing `readingsQueryUrl` / `latestReadingUrl` / `mapRow` unchanged.
- `app.js`: `buildOption` updated for the time axis, pair-based series, bounds,
  and tooltip-row value access; gains range/now parameters. `render` passes them.
- `test/data.test.js`: new unit tests for the two helpers.

## Testing

Unit tests (node --test, zero deps) in `test/data.test.js`:

- `toSeriesPairs`:
  - continuous run (all gaps ≤ threshold) → pairs only, no null items.
  - a gap > `gapBreakMs` → exactly one `[ms, null]` break inserted between the
    two readings; gap ≤ threshold → no break.
  - an isolated reading (break before and after) is still present as a pair.
  - a reading whose `key` value is `null` → `[ms, null]` passthrough.
  - timestamps are `epoch * 1000` (ms).
- `rangeBounds`:
  - `24h` / `7d` / `30d` → `{ min: (now−range)*1000, max: now*1000 }`.
  - `all` (and an unknown key) → `{ min: undefined, max: now*1000 }`.

Visual verification (serve the page): a real >6h gap shows a broken line; a
stale tail shows empty space up to the right edge; an isolated reading shows a
dot; tooltip and axis labels still render Norwegian Oslo times and correct
values.

## Decisions (not open questions)

- Break threshold is a single constant `GAP_BREAK_MS = 6h`, tunable in one place.
- Right edge is pinned to `now` for the fixed ranges (and `all`); left edge is
  `now − range` for fixed ranges and auto for `all`.
- Isolated dots rely on ECharts' built-in isolated-point symbol behavior;
  scatter-overlay fallback only if that proves untrue in the visual check.
- `connectNulls` stays at its default `false`.

## Out of scope

- Backend / poller / Supabase changes.
- Changing the set of ranges or adding new ones.
- Interpolating or back-filling missing readings.
