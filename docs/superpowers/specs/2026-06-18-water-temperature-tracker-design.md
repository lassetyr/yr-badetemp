# Water Temperature Tracker (`yr-badetemp`) — Design

**Date:** 2026-06-18
**Status:** Approved

## Overview

A zero-cost, always-on app that records the water temperature at **Dulpen,
Holmestrand** every hour and displays the history in a polished interactive
chart. There is no server, no database, and no cold-starts: GitHub Actions
polls the API, the git repo stores the data, and GitHub Pages serves the
chart.

## Data source

- **Endpoint:** `https://www.yr.no/api/v0/watertemperatures/10/541/300`
- **Shape:** GeoJSON `FeatureCollection`. Each feature is one bathing spot with
  `properties` including `locationId`, `name`, `timestamp`, `timestampEpoch`,
  `waterTemperature`, `airTemperature`, `windSpeed`, `windGust`,
  `windDirection`, `symbol`, `isStale`.
- **Key property:** the endpoint returns a *current snapshot* across ~28 spots,
  not a time series. History must be accumulated by polling over time.
- **Tracked spot:** Dulpen, Holmestrand — `locationId = "0-10238"`.
- **Update cadence of source:** readings often only refresh every few hours,
  so polling more often than hourly yields duplicate values.

## Architecture

Three decoupled pieces:

### 1. Poller (GitHub Actions)

- A workflow triggered on an hourly `cron` schedule (plus a manual
  `workflow_dispatch` for testing).
- Runs a small script that:
  1. Fetches the API.
  2. Finds the feature whose `locationId` is `0-10238`.
  3. Reads the last stored line of the data file.
  4. **Dedupe:** appends a new reading only if the source `timestamp` is newer
     than the last stored reading's timestamp.
  5. If appended, commits the changed data file back to the repo.
- Runs entirely on GitHub's free hosted runners.

### 2. Data store (append-only file in repo)

- Path: `data/dulpen.ndjson`.
- One JSON object per line (newline-delimited JSON), e.g.:

  ```json
  {"time":"2026-06-18T18:38:27+02:00","epoch":1781800707,"water":16.6,"air":23.5,"windSpeed":0.8,"windGust":2.6,"windDir":78}
  ```

- Append-only: new readings are added as lines; git provides version history.
- Chosen over a single JSON array because appending a line needs no
  parse-modify-rewrite and avoids merge churn.

### 3. Frontend (static page on GitHub Pages)

- A single static `index.html` plus a small amount of JS/CSS.
- Fetches `data/dulpen.ndjson`, parses it client-side, renders the chart.
- Charting library: a lightweight, capable option — **uPlot** or **ECharts**
  (final choice made during planning).

## The chart

- **Primary series:** water temperature (the hero line), with a subtle gradient
  fill beneath it.
- **Overlay series:** air temperature and wind (speed/gust).
- **Interactivity:** hover tooltips; time-range toggles (24h / 7d / 30d / all);
  a header showing the latest reading and its "as of" timestamp.
- **Aesthetic:** clean, modern, smooth lines, readable on mobile.

## Error handling

- API request fails, or spot `0-10238` is absent from the response → log and
  exit cleanly, appending nothing. The next hourly run retries.
- Reading unchanged (timestamp not newer) → skip the append; the workflow still
  succeeds.
- Commit only when the data file actually changed, to avoid empty commits.

## Out of scope (YAGNI)

- Tracking multiple spots.
- A real database or backend server.
- User accounts / authentication.
- Alerting or notifications.

These can be revisited later; the initial build is a single spot, a flat file,
and a static page.

## Success criteria

- The hourly workflow runs and appends a new reading whenever the source
  timestamp advances.
- Duplicate / unchanged readings are not appended.
- The GitHub Pages site loads the data and renders an interactive chart with
  water temperature plus air and wind overlays and working time-range toggles.
- No paid infrastructure is required.
