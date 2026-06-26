# Design: Transition to the official Yr water-temperature API (hybrid)

**Date:** 2026-06-26
**Status:** Approved — pending Yr API key before live cutover

## Problem

The poller currently reads `https://www.yr.no/api/v0/watertemperatures/10/541/300`
— an **undocumented internal endpoint** that powers the yr.no website/apps. It
works, but it is not a sanctioned external interface: the path segments
(`10/541/300`) are internal grid coordinates, there are no terms we are
operating under, and it can change or block us without notice.

Yr publishes an **official, documented water-temperature API** intended for
external use. We should move onto it. An API key has been requested from
`support@yr.no` (subject "Forespørsel om API-nøkkel til badetemperaturer") but
has not yet arrived, so the live cutover is gated on that key.

## The official API (facts)

Source: <https://hjelp.yr.no/hc/no/articles/5949243432850-API-for-badetemperaturer>
(saved locally at `docs/yr.no/API for badetemperaturer – Yr hjelp og informasjon.html`).

- **Base URL:** `https://badetemperaturer.yr.no`
- **Auth:** an `apikey` HTTP header carrying the issued key. No User-Agent
  requirement (unlike api.met.no).
- **Endpoints we care about:**
  - `GET /api/locations/{locationId}/watertemperatures` — the 5 most recent
    readings for one spot.
  - `GET /api/locations/{lat},{lon}/nearestwatertemperatures` — the 6 nearest
    registrations within 50 km (used only to discover Dulpen's official ID).
- **Per-reading payload:** `{ "temperature": <number>, "time": <ISO-8601 with
  offset> }`. **No `epoch`, no air temperature, no wind** — water only.
- **Constraints:** does not serve readings older than 5 days; returns the same
  latest reading until a new measurement exists; no SLA.
- **Terms we must honor:** display **"Badetemperaturer levert av Yr"**
  prominently next to the temperatures; do not alter values; do not impersonate
  Yr. Commercial use is permitted if the rules are followed.

### Why this is not a drop-in swap

The internal endpoint enriches each water reading with `airTemperature`,
`windSpeed`, `windGust`, `windDirection`, and `timestampEpoch`. The official API
carries none of that. Our chart plots **water + air + wind speed**
(`app.js:114/130/140`) and the table stores `air`, `wind_speed`, `wind_gust`,
`wind_dir`. A pure switch would silently drop two of three chart series.

## Chosen approach: hybrid (Yr water + MET Norway weather)

Keep full feature parity using two **official** sources:

- **Water temperature** ← `badetemperaturer.yr.no` (the real measurement).
- **Air + wind** ← MET Norway **Locationforecast 2.0**
  (`https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=&lon=`),
  free, no key, requires an identifying `User-Agent`. The first timeseries entry
  is the current-hour model value — which is the same forecast-grade data the
  unofficial endpoint already returns, so this is parity, not a downgrade.

Rejected alternatives:

- **Water-only (drop air/wind):** simplest, single source, but removes two chart
  series and discards a feature we have today.
- **Keep the unofficial endpoint for air/wind enrichment:** defeats the purpose
  — we want off the undocumented endpoint entirely.
- **MET Frost (real observations) for air/wind:** real sensor data, but a
  separate registration, the nearest station is some km from Dulpen, higher
  latency, and it would *diverge* from what yr.no shows. YAGNI.

## Architecture & data flow

The existing seam holds: all I/O in `poll.js`, all parsing pure in `lib.js`.

```
poll.js (per poll)
 ├─ water   ← GET badetemperaturer.yr.no/api/locations/{QUERY_ID}/watertemperatures
 │            header: apikey: $YR_API_KEY
 │            extractOfficialWater(json) → {temperature, time, epoch}
 │            (network/HTTP/parse failure → return; no row this poll)
 ├─ weather ← GET api.met.no/weatherapi/locationforecast/2.0/complete?lat=&lon=
 │            header: User-Agent: $MET_USER_AGENT
 │            extractForecast(json) → {air, windSpeed, windGust, windDir}
 │            (any failure → null fields; continue)
 └─ toRow(water, weather, STORAGE_ID)
        → POST {SUPABASE_URL}/rest/v1/readings
          Prefer: resolution=ignore-duplicates   (unchanged; PK keeps it idempotent)
```

### Failure semantics (water-anchored)

- Water fetch fails → insert nothing this poll (water is the whole point; `epoch`
  is derived from the water reading's timestamp).
- Weather fetch fails → insert a water-only row with `air`/`wind_*` left null.
  The columns are already nullable and the chart already tolerates gaps.
- All failures `return` (exit 0), matching the existing "wait for the next
  scheduled poll" convention.

## The two location IDs (decoupled)

- **STORAGE_ID = `"0-10238"`** — written to `location_id` unchanged, so new
  readings line up with the existing history on a single chart.
- **QUERY_ID** — sent to `badetemperaturer.yr.no`. It is **unknown** whether
  `0-10238` resolves there (every documented example uses a `1-…` ID).
  Resolution (key-gated, see Rollout): try
  `GET /api/locations/0-10238/watertemperatures`; if it 404s or returns empty,
  use `GET /api/locations/{lat},{lon}/nearestwatertemperatures` to discover
  Dulpen's official ID, then hardcode it as `QUERY_ID`. STORAGE_ID stays
  `0-10238` regardless.
- **Dulpen lat/lon** — needed for met.no and the ID-resolution fallback.
  Captured once from the current unofficial GeoJSON (`position`) before that
  endpoint is retired.

## Pure helpers in `lib.js` (test-driven)

- `extractOfficialWater(json)` → `{ temperature, time, epoch }` or `null`. Picks
  the entry with the **newest parseable `time`** (does not rely on array order),
  validates `temperature` is numeric; `epoch = Math.floor(Date.parse(time)/1000)`.
- `extractForecast(json)` → `{ air, windSpeed, windGust, windDir }`, each `null`
  when absent. Reads `properties.timeseries[0].data.instant.details` and maps
  `air_temperature` → `air`, `wind_speed` → `windSpeed`, `wind_speed_of_gust` →
  `windGust`, `wind_from_direction` → `windDir`.
- `toRow(water, forecast, locationId)` → snake_case row
  (`location_id, epoch, time, water, air, wind_speed, wind_gust, wind_dir`).

The current GeoJSON `extractReading` / `toRow` stay until cutover is proven, then
are removed together with their tests.

## Schema, config, frontend

- **Schema:** no change. `air`/`wind_*` already nullable; `epoch` remains
  `bigint`, now derived from the ISO `time` rather than supplied as
  `timestampEpoch`.
- **Config / secrets:**
  - `YR_API_KEY` — GitHub Actions secret + local env (read side of the key).
  - `MET_USER_AGENT` — identifying string required by met.no, e.g.
    `yr-badetemp/1.0 (github.com/<owner>/yr-badetemp; lassetyr@gmail.com)`.
  - New constants in `poll.js`: water API base URL, `QUERY_ID`, `STORAGE_ID`,
    `LAT`, `LON`, met.no forecast URL.
- **Frontend:** add attribution visible near the chart — **"Badetemperaturer
  levert av Yr"** and **"Værdata fra MET Norway"**. No chart logic changes
  (still water + air + wind speed).

## Rollout (key-gated)

All code lands on a branch first; the live scheduled poller is untouched until
the key is verified.

1. **Merge-safe:** add the new pure helpers + unit tests (no behavior change).
2. **New path:** rewrite `poll.js` onto the official + met.no flow on the branch.
3. **Verification gate (requires the key):** set `YR_API_KEY`, fire one manual
   `workflow_dispatch` from the branch, and confirm Dulpen resolves and a row
   inserts with sane water/air/wind values — while `main`'s cron still runs the
   old unofficial poller, giving a free side-by-side comparison without
   duplicating scripts.
4. **Cut over:** merge → cron now uses the official path; the unofficial endpoint
   is dropped. `data/dulpen.ndjson` remains a frozen historical backup.

## Decisions made (defaults, not open questions)

- met.no **`complete`** (not `compact`) so `wind_speed_of_gust` is available and
  `wind_gust` parity is preserved.
- met.no's `Expires`/caching headers are noted but **not** implemented — the
  20-minute poll cadence is well within met.no's limits.
- If Dulpen goes >5 days without a reading the per-location endpoint returns
  empty; we simply skip that poll and the chart shows the last known value.

## Testing

- Unit tests (node --test, zero deps) for `extractOfficialWater` (newest-wins,
  missing/non-numeric temp, empty array, epoch derivation), `extractForecast`
  (full details, missing fields → nulls, malformed shape), and `toRow`.
- Live verification is the key-gated manual `workflow_dispatch` in Rollout step 3.

## Out of scope

- Adding more spots (the `location_id` seam already exists; only Dulpen is
  written).
- Backfilling history from the official API (it serves only the last 5 days).
- Switching air/wind to real observations (MET Frost) — see rejected
  alternatives.
