# Periodic data auto-refresh

**Date:** 2026-06-19
**Status:** Approved (design)

## Problem

`index.html` + `app.js` fetch `data/dulpen.ndjson` exactly once, on page load
(`init()`). The data file is refreshed server-side every 20 minutes by the
GitHub Actions poll, but a viewer with the page open never sees new readings
without manually reloading. We want the page to pick up new data on its own —
by re-fetching the data periodically, not by reloading the page.

## Goals

- Re-fetch `data/dulpen.ndjson` on a timer and re-render the chart + header
  without a full page reload.
- Preserve the user's current view (selected time range, legend toggles).
- Pause polling while the tab is hidden; resume with an immediate fetch on
  return.

## Non-goals

- No change to the server-side poll cadence or data format.
- No new UI controls, no new dependencies.
- No persistence of new state beyond what already exists (`legendSelected`).

## Decisions

- **Interval:** 5 minutes. The source updates every ~20 min, so 5 min picks up
  new readings promptly without excessive requests.
- **Tab visibility:** pause the timer when hidden; on becoming visible, fetch
  immediately and restart the timer.
- **Indicator:** none beyond the existing header "oppdatert ..." timestamp,
  which already communicates freshness. The chart and timestamp update silently.

## Design

All changes are in `app.js`. No HTML/CSS changes.

### `loadData()` — extracted from `init()`

Pull the fetch + parse + `updateHeader()` + `render()` out of `init()` into a
reusable async `loadData()`. Behavioral difference between the two paths:

- **Initial load** (current `init()` behavior): on fetch failure, fall back to
  `[]`, which shows the empty state.
- **Refresh:** on fetch failure, leave the existing `allReadings` and rendered
  chart untouched — a transient network blip must not blank a working chart.

Implementation: `loadData()` fetches and, only on success, replaces
`allReadings` and calls `updateHeader()` + `render()`. `init()` calls
`loadData()` once, and additionally renders the empty state if there is still
no data after that first load.

### Timer

- `REFRESH_MS = 5 * 60 * 1000` constant.
- A module-level `timerId` variable.
- `startRefreshTimer()` — sets `timerId = setInterval(loadData, REFRESH_MS)`
  (guarding against double-start).
- `stopRefreshTimer()` — `clearInterval(timerId)` and clears `timerId`.

### Visibility handling

A `visibilitychange` listener:

- `document.hidden === true` → `stopRefreshTimer()`.
- `document.hidden === false` → `loadData()` immediately, then
  `startRefreshTimer()`.

On initial load (tab visible), `startRefreshTimer()` after the first
`loadData()`.

### State preservation

No extra work required:

- `currentRange` is a module variable read by `render()`, so the selected range
  survives a refresh.
- Legend on/off state is already persisted in `legendSelected` and reapplied
  via `buildOption()`'s `legend.selected`.

A refresh re-runs `render()`, which rebuilds the chart from `allReadings` while
honoring `currentRange` and `legendSelected` — so range, legend, and axes are
unchanged; only the data and the "oppdatert" timestamp move.

## Testing

- `src/data.js` (`parseNdjson`, `filterByRange`) is unchanged; existing unit
  tests continue to cover data shaping.
- The timer + visibility behavior is DOM/timer-bound; verify manually in the
  browser:
  - Chart updates after the interval when `data/dulpen.ndjson` changes.
  - Selected range and legend toggles survive a refresh.
  - Polling pauses when the tab is hidden and refetches on return.
  - A failed refresh leaves the existing chart intact.
