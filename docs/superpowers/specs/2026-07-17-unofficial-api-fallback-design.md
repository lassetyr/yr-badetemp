# Design: Unofficial-endpoint fallback while `YR_API_KEY` is unset

**Date:** 2026-07-17
**Status:** Approved — ready to plan
**Branch:** `feat/official-yr-watertemp-api`

## Problem

The official-API transition (see
`2026-06-26-official-yr-watertemp-api-design.md`) rewrote `poll.js` into a hard
cutover: the poller now requires `YR_API_KEY` and, when the key is absent,
inserts nothing and exits 0:

```js
if (!YR_API_KEY) {
  console.error("Missing YR_API_KEY.");
  return; // exit 0; next scheduled run retries
}
```

The unofficial endpoint (`www.yr.no/api/v0/watertemperatures/10/541/300`) was
removed from `poll.js` entirely. So the moment this branch runs live without the
key, data collection **silently stops** — there is no graceful degradation to
today's working behavior. Since the key has been requested but not received, we
want the branch to be mergeable and keep collecting data in the meantime.

The word "hybrid" in the transition design means *two upstream sources* (Yr water
+ MET Norway weather) for the official path. It does **not** mean official-with-
unofficial fallback. This spec adds that fallback.

## Goal

Make the poller degrade gracefully: use the official + met.no path when
`YR_API_KEY` is set, and otherwise fall back to the pre-transition unofficial
GeoJSON path — so the branch keeps writing readings until the key lands, then
switches to the official path automatically the first poll after the key is set.

## Decisions (settled during brainstorming)

- **Trigger: missing key only.** `YR_API_KEY` present → official path;
  `YR_API_KEY` absent → unofficial path. The key is the single switch. A runtime
  failure of the official API does **not** fall back — it skips the poll, exactly
  as the official path does today. (This avoids masking official-API outages and
  keeps the switch trivially predictable.)
- **Lifespan: temporary scaffold.** The unofficial path exists only to keep data
  flowing until the key is verified live. Once cutover is proven, the unofficial
  path and its helpers are deleted. The two paths are therefore kept cleanly
  separated so removal is a subtraction, not surgery.

## Why this is nearly free

The branch's `lib.js` still contains **both** helper sets — the transition kept
`extractReading` / `toRow` (unofficial) alongside `extractOfficialWater` /
`extractForecast` / `buildRow` (official). Both emit the **identical** row shape:

```
{ location_id, epoch, time, water, air, wind_speed, wind_gust, wind_dir }
```

So the fallback needs **no new pure logic** — every helper it calls is already
present and unit-tested in `test/lib.test.js`. This is almost entirely a
`poll.js` change: reintroduce the unofficial fetch as one self-contained
function and switch on the key.

## Architecture & data flow

The seam is unchanged: all I/O in `poll.js`, all parsing pure in `lib.js`. The
`main()` flow gains a provider switch and a shared insert.

```
poll.js (per poll)
  main():
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return         // exit 0
    const row = YR_API_KEY ? await pollOfficial()
                           : await pollUnofficial()
    if (!row) return                                           // both fail soft
    await insertRow(row)

  pollOfficial():        // needs YR_API_KEY (existing branch logic, refactored)
    water    ← GET badetemperaturer.yr.no/api/locations/{QUERY_ID}/watertemperatures
               header: apikey: $YR_API_KEY
               extractOfficialWater(json)          // null → return null (no row)
    forecast ← GET api.met.no/.../locationforecast/2.0/complete?lat=&lon=
               header: User-Agent: $MET_USER_AGENT
               extractForecast(json)               // failure → null (water-only row)
    return buildRow(water, forecast, STORAGE_ID)

  pollUnofficial():      // no key (pre-transition logic, restored)
    geojson  ← GET www.yr.no/api/v0/watertemperatures/10/541/300
               extractReading(geojson, LOCATION_ID)  // null → return null (no row)
    return toRow(reading, LOCATION_ID)

  insertRow(row):        // unchanged Supabase POST
    POST {SUPABASE_URL}/rest/v1/readings
      Prefer: resolution=ignore-duplicates          // PK keeps it idempotent
```

`STORAGE_ID` and `LOCATION_ID` are the same value (`"0-10238"`) and both write
it to `location_id`, so history stays continuous across the switch on a single
chart.

### Refactor shape

Today `pollOfficial`'s body lives inline in `main()` as `fetchWater` +
`fetchForecast` + the insert. The change:

1. Extract the existing insert block into `insertRow(row)`.
2. Wrap the existing water+forecast+buildRow logic into `pollOfficial()`
   returning a row or `null` (fold `fetchWater`/`fetchForecast` under it, or keep
   them as-is and have `pollOfficial` call them).
3. Add `pollUnofficial()` returning a row or `null`.
4. Reduce `main()` to: env guard → pick provider by `YR_API_KEY` → `insertRow`.

Each provider owns its own endpoint constants and returns the same row shape, so
`main()` and `insertRow` are provider-agnostic.

## Config

Add back the unofficial endpoint constants next to the official ones in
`poll.js`, grouped so the scaffold is visually obvious:

```js
// --- Unofficial fallback (removed once YR_API_KEY is verified live) ---------
const LEGACY_API_URL = "https://www.yr.no/api/v0/watertemperatures/10/541/300";
const LOCATION_ID = "0-10238"; // feature match in the GeoJSON; == STORAGE_ID
```

No new secrets, no schema change, no frontend change.

## Failure semantics (unchanged, per path)

Both providers are water-anchored and fail soft — any network/HTTP/parse
failure, or a missing water reading, returns `null`, and `main()` inserts
nothing and exits 0 ("wait for the next scheduled poll"). The official path
additionally tolerates a met.no failure by emitting a water-only row; the
unofficial GeoJSON carries its own air/wind in the same response, so it has no
second fetch to tolerate.

## Startup log line

`main()` (or each provider) logs which path ran, so a CI log makes the mode
obvious at a glance — e.g. `Polling via official API` vs
`Polling via unofficial API (YR_API_KEY unset)`. This is the fast signal that
the key has (or hasn't) taken effect after it's configured.

## No dup-row risk in practice

The two paths derive `epoch` differently — unofficial uses the GeoJSON's
supplied `timestampEpoch`, official uses `Math.floor(Date.parse(time)/1000)`. If
both ran over the same measurement they *could* produce PKs a second or two
apart. But the transition is **one-way**: the poller runs the unofficial path
until the key is set, then the official path forever — the two never interleave
on the same schedule. So no guard is needed; this is a documentation note, not a
code concern.

## Testing

- **No new unit tests required.** The fallback introduces no new pure logic;
  `extractReading` / `toRow` and the official helpers are already covered in
  `test/lib.test.js`. Confirm the existing suite still passes (`npm test`).
- **Manual smoke (no key):** run `poll.js` locally with Supabase creds but
  **without** `YR_API_KEY`; confirm it logs the unofficial path and inserts a
  row with air/wind populated (the GeoJSON carries them).
- **Key-gated verification (from the transition plan, unchanged):** once
  `YR_API_KEY` is set, one manual `workflow_dispatch` should log the official
  path and insert a sane official row.

## Removal (when cutover is proven)

A clean subtraction once the key is verified live:

1. Delete `pollUnofficial()` and the `LEGACY_API_URL` / `LOCATION_ID` constants
   from `poll.js`; drop the provider switch so `main()` calls `pollOfficial()`
   directly (restoring the current branch's missing-key guard).
2. Delete `extractReading` / `toRow` from `lib.js` and their tests from
   `test/lib.test.js`.

Because the unofficial path is one function backed by its own helpers, this
lifts out without touching the official path.

## Out of scope

- Runtime fallback on official-API failure (explicitly rejected — trigger is
  missing-key-only).
- Keeping the unofficial path permanently (explicitly a temporary scaffold).
- Any change to the official path's behavior, the schema, the frontend, or
  attribution (both Yr and MET attributions stay in `index.html` regardless of
  which path ran — the page can't know, and both are harmless to show).
