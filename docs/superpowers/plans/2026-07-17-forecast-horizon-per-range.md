# Per-range Forecast Horizon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trim how much of the 48h projection is *drawn* per selected range (24t → 12h ahead; 7d/30d/all → full 48h), so the observed data keeps its share of the chart.

**Architecture:** Display-only. A pure `clampForecast` helper in `src/data.js` filters the already-fetched `{line,lower,band}` to a horizon; a policy map in `app.js` maps range → horizon; `buildOption` clamps once and uses the clamped result for both the drawn series and the axis right-edge. Nothing about the poller, schema, or fetch changes.

**Tech Stack:** Native ES modules, ECharts (CDN global), `node --test` (zero deps).

## Global Constraints

- **Zero dependencies**, pure JS only.
- **Pure/I-O split:** the clamp logic goes in `src/data.js` (I/O-free, unit-tested via `node --test`); the range→horizon policy lives in `app.js` (per the convention that `src/data.js` stays free of policy).
- **Display-only:** no change to `scripts/poll.js`, `scripts/lib.js`, `supabase/schema.sql`, or the browser's fetch/`loadForecast`. The full 48h projection is still stored, fetched, and held in the `forecast` module variable.
- **Horizon caps (exact):** `{ "24h": 12, "7d": 48, "30d": 48, "all": 48 }` (hours). Unknown range → default `48`.
- **Seed retained:** `points[0]` (seed at ≈now) must survive every clamp so the dashed line still joins the solid line and the band opens from zero width.
- **All commits** end with the trailer `Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe`.

---

## File Structure

- `src/data.js` — **modify**: add pure `clampForecast(forecast, nowEpochSec, maxHorizonH)`.
- `test/data.test.js` — **modify**: tests for `clampForecast`.
- `app.js` — **modify**: import `clampForecast`, add the `FORECAST_HORIZON_H` policy map, clamp inside `buildOption` and thread the clamped `fc` into the axis + series.

---

## Task 1: `clampForecast` pure helper

**Files:**
- Modify: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Consumes: a `{ line, lower, band }` object as produced by `mapForecast` (arrays of `[ms, value]` pairs, all sharing the same timestamps), or `null`.
- Produces: `clampForecast(forecast, nowEpochSec, maxHorizonH) -> { line, lower, band } | null`. Keeps only pairs with `ms <= (nowEpochSec + maxHorizonH*3600)*1000`; returns `null` when `forecast` is null/empty or nothing survives.

- [ ] **Step 1: Write the failing test**

Add `clampForecast` to the `../src/data.js` import block in `test/data.test.js`, then add:

```js
// Forecast as mapForecast emits it: line/lower/band share timestamps. Points at
// now, +6h, +12h, +24h, +48h (nowEpochSec = 1000 → ms = epoch*1000).
const FC_NOW = 1000;
const FC = {
  line:  [[1_000_000, 20], [22_600_000, 20.2], [44_200_000, 20.4], [87_400_000, 20.1], [173_800_000, 19.5]],
  lower: [[1_000_000, 20], [22_600_000, 19.9], [44_200_000, 19.8], [87_400_000, 19.3], [173_800_000, 18.5]],
  band:  [[1_000_000, 0],  [22_600_000, 0.6],  [44_200_000, 1.2],  [87_400_000, 1.6],  [173_800_000, 2.0]],
};

test("clampForecast keeps points within the horizon, drops those beyond, retains the seed", () => {
  const c = clampForecast(FC, FC_NOW, 12); // cutoff = (1000 + 12*3600)*1000 = 44_200_000
  assert.equal(c.line.length, 3);          // now, +6h, +12h (== cutoff, inclusive)
  assert.deepEqual(c.line[0], [1_000_000, 20]);           // seed retained
  assert.equal(c.line[c.line.length - 1][0], 44_200_000); // last drawn point at +12h
  // line/lower/band clamped to the SAME timestamps
  assert.deepEqual(c.lower.map((p) => p[0]), c.line.map((p) => p[0]));
  assert.deepEqual(c.band.map((p) => p[0]), c.line.map((p) => p[0]));
});

test("clampForecast at the full 48h horizon keeps every point", () => {
  const c = clampForecast(FC, FC_NOW, 48);
  assert.equal(c.line.length, 5);
});

test("clampForecast returns null for a null or empty forecast", () => {
  assert.equal(clampForecast(null, FC_NOW, 12), null);
  assert.equal(clampForecast({ line: [], lower: [], band: [] }, FC_NOW, 12), null);
});

test("clampForecast returns null when nothing is within the horizon", () => {
  // A forecast whose only point is +24h, viewed with a 12h horizon → all dropped.
  const late = { line: [[87_400_000, 20]], lower: [[87_400_000, 19]], band: [[87_400_000, 1]] };
  assert.equal(clampForecast(late, FC_NOW, 12), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data.test.js`
Expected: FAIL — `clampForecast is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Append to `src/data.js`:

```js
// Trim a mapped forecast ({line,lower,band}) to a display horizon: keep only the
// pairs at or before `nowEpochSec + maxHorizonH` hours. line/lower/band share
// timestamps, so filtering each by the same cutoff keeps them consistent. Returns
// null when there is nothing to draw (no forecast, or nothing within the horizon).
export function clampForecast(forecast, nowEpochSec, maxHorizonH) {
  if (!forecast || !forecast.line?.length) return null;
  const cutoffMs = (nowEpochSec + maxHorizonH * 3600) * 1000;
  const line = forecast.line.filter(([ms]) => ms <= cutoffMs);
  if (line.length === 0) return null;
  return {
    line,
    lower: forecast.lower.filter(([ms]) => ms <= cutoffMs),
    band: forecast.band.filter(([ms]) => ms <= cutoffMs),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: clampForecast trims a mapped forecast to a display horizon

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 2: Wire per-range horizon into the chart

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: `clampForecast(forecast, nowEpochSec, maxHorizonH)` from `./src/data.js` (Task 1).
- Produces: `buildOption` draws the range-clamped projection and pins the axis right-edge to the clamped forecast's last point.

- [ ] **Step 1: Import `clampForecast`**

In `app.js`, add `clampForecast` to the `./src/data.js` import block (it already imports `forecastQueryUrl`, `mapForecast`, etc.):

```js
  forecastQueryUrl,
  mapForecast,
  clampForecast,
```

- [ ] **Step 2: Add the policy map**

In `app.js`, right after the line `const TREND_SAMPLE = 3; // readings averaged at each end for the period trend`, add:

```js
// How far ahead (hours) to DRAW the 48h projection per selected range. The full
// projection is always stored/fetched; wider ranges have room for all of it, and
// 24t is trimmed so the observed data keeps its share of the chart.
const FORECAST_HORIZON_H = { "24h": 12, "7d": 48, "30d": 48, "all": 48 };
```

- [ ] **Step 3: Clamp inside `buildOption` and drive the axis from the clamped result**

In `app.js`, in `buildOption`, replace this block:

```js
  const bounds = rangeBounds(rangeKey, nowEpochSec);
  // When a projection is present, extend the right edge to its last point so the
  // 48h dashed line + band aren't clipped by the now-pinned axis max.
  const fcMaxMs = forecast?.line?.length
    ? forecast.line[forecast.line.length - 1][0]
    : null;
  const axisMax = fcMaxMs != null && fcMaxMs > bounds.max ? fcMaxMs : bounds.max;
```

with:

```js
  const bounds = rangeBounds(rangeKey, nowEpochSec);
  // Trim how much of the projection is drawn for the selected range (the full 48h
  // is always stored/fetched; only the display is capped). The clamped `fc` drives
  // both the series and the axis right-edge below.
  const fc = clampForecast(forecast, nowEpochSec, FORECAST_HORIZON_H[rangeKey] ?? 48);
  // When a projection is present, extend the right edge to its last drawn point so
  // the dashed line + band aren't clipped by the now-pinned axis max.
  const fcMaxMs = fc?.line?.length ? fc.line[fc.line.length - 1][0] : null;
  const axisMax = fcMaxMs != null && fcMaxMs > bounds.max ? fcMaxMs : bounds.max;
```

- [ ] **Step 4: Point the forecast series at the clamped `fc`**

In `app.js`, in the `series` array's forecast spread, change the guard and the three data references from `forecast` to `fc`. Replace `...(forecast` with `...(fc`:

```js
      ...(fc
        ? [
```

and change the three data lines:

```js
              data: fc.lower,
```
```js
              data: fc.band,
```
```js
              data: fc.line,
```

(Leave the `render()` call site `buildOption(allReadings, forecast, currentRange, nowEpoch())` unchanged — `buildOption` clamps the module `forecast` internally.)

- [ ] **Step 5: Verify syntax and the suite**

Run: `node --check app.js`
Expected: no output (valid syntax).

Run: `npm test`
Expected: full suite green (`clampForecast` tests + all pre-existing).

- [ ] **Step 6: Browser check (deferred to the human)**

There are no unit tests for `app.js`, and this is a visual change that needs a browser + a populated `forecast` row. This step is **deferred to the human**: serve the site (`python3 -m http.server 8000`), and on **24t** confirm the dashed line + band now extend only ~12h past the last solid point (axis right-edge ≈ now+12h), while **7d/30d/Alle** still show the full 48h. The implementer should NOT attempt this; note it as deferred in the report.

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "feat: draw the projection only as far ahead as the selected range warrants

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Self-Review

**Spec coverage:**
- Display-only trim, full projection still stored/fetched → Task 2 clamps at render; no poller/schema/fetch change. ✓
- Horizon caps `{24h:12, 7d:48, 30d:48, all:48}` → `FORECAST_HORIZON_H` (Task 2 Step 2). ✓
- Pure helper in `src/data.js`, policy in `app.js` → Tasks 1 & 2. ✓
- Clamped result drives both series and axis edge → Task 2 Steps 3–4. ✓
- Seed retained; anchor is `now` → `clampForecast` keeps `ms <= now+cap` and the seed sits at ≈now (Task 1 test asserts seed retention). ✓
- Empty result → null → no projection, axis stays at `bounds.max` → `clampForecast` returns null, the `...(fc ? … : [])` guard omits the series and `fcMaxMs` is null (Task 2). ✓
- Staleness unchanged → `loadForecast`'s `FORECAST_STALE_SEC` drop is untouched. ✓
- TDD, zero deps → Task 1 is test-first; no packages. ✓

**Placeholder scan:** none — every step has complete code. ✓

**Type consistency:** `clampForecast(forecast, nowEpochSec, maxHorizonH)` returns `{line,lower,band}|null`, matching `mapForecast`'s shape and how the series spread + `fcMaxMs` consume it. `FORECAST_HORIZON_H[rangeKey] ?? 48` yields a number; `rangeKey` values (`"24h"/"7d"/"30d"/"all"`) match the map keys and the existing `RANGES`. ✓
