# Mean-Air-Coupled Water Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Couple the water-temperature projection to a 24-hour trailing-mean air temperature (and drop the `c` intercept) so it tracks sustained air changes instead of crawling, and fix the history fetch so the fit uses the full window rather than Supabase's 1000-row cap.

**Architecture:** All model changes are pure and live in `scripts/lib.js`. A new `smoothAirSeries` helper produces the trailing-mean driver; `fitRelaxation` fits `a, b` only (no intercept); `buildProjection` wires smoothing in *upstream* of the unchanged `rollForward`/`backtestError` machinery, smoothing across the history→forecast seam so the driver isn't cold-started. The stored payload shape is unchanged, so the browser, schema, and `src/data.js` are untouched. Separately, `scripts/poll.js`'s `fetchHistory` paginates the read.

**Tech Stack:** Native ES modules, `node --test` (zero deps, Node 20+). No bundler, no packages.

## Global Constraints

- **Zero dependencies**, pure JS only. No new packages.
- **Pure/I-O split:** model logic goes in `scripts/lib.js` (I/O-free, unit-tested via `node --test`); side effects stay in `scripts/poll.js` (untested by convention — verified with `node --check` + a live run).
- **Smoothing window:** `SMOOTH_WINDOW_H = 24` (hours), a new tunable constant.
- **Drop the intercept:** `fitRelaxation` fits `a, b` only and always reports `c: 0`.
- **Smoothing is internal to the water model only** — the `air`/`windSpeed`/`windDir` values stored on each projection point (which the browser draws) stay the **raw** met.no forecast; only wind is never smoothed at all, and air is smoothed only as the model *driver*.
- **Payload shape is unchanged:** points remain `{ epoch, water, lower, upper, air, windSpeed, windDir }`; top-level payload remains `{ horizonH, model, coeffs, backtest, points }` with `coeffs` = `{ a, b, c }` (now `c: 0`) when `ok`, else `null`. Do **not** touch `app.js`, `src/data.js`, `index.html`, or `supabase/schema.sql`.
- **History fetch bounded** by `FIT_WINDOW_DAYS` (already imported in `poll.js`); pagination must terminate.
- **All commits** end with the trailer:
  `Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe`

---

## File Structure

- `scripts/lib.js` — **modify**: add `SMOOTH_WINDOW_H` + `smoothAirSeries`; change `fitRelaxation` (fit `a,b`, add `solve2`, remove now-dead `det3`/`solve3`); rewire `buildProjection`.
- `test/lib.test.js` — **modify**: tests for `smoothAirSeries`; update `fitRelaxation` tests to the no-`c` contract; replace the `buildProjection` tests with mean-air versions + add smoothed-driver and seam tests.
- `scripts/poll.js` — **modify**: paginate `fetchHistory`.
- `CLAUDE.md` — **modify**: update the Forecast architecture bullet and Config knobs.

---

## Task 1: `smoothAirSeries` + `SMOOTH_WINDOW_H`

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Produces: `SMOOTH_WINDOW_H` (number, `24`) and `smoothAirSeries(series, windowH = SMOOTH_WINDOW_H) -> Array`. Input is an epoch-ascending array of entries with at least `{ epoch, air }` (plus optional `water`/`windSpeed`/`windDir`). Output is a new array, same length and order, each entry shallow-copied with `air` replaced by the trailing mean of `air` over `[epoch - windowH*3600, epoch]` (inclusive), computed over non-null airs in that window; an entry with no non-null air in its window gets `air: null`. All other fields are preserved.

- [ ] **Step 1: Write the failing tests**

Add `smoothAirSeries` and `SMOOTH_WINDOW_H` to the `../scripts/lib.js` import block in `test/lib.test.js`, then add:

```js
test("smoothAirSeries replaces air with the trailing-window mean, preserving other fields", () => {
  const series = [
    { epoch: 0, air: 10, windSpeed: 1 },
    { epoch: 3600, air: 20, windSpeed: 2 },
    { epoch: 7200, air: 30, windSpeed: 3 },
  ];
  const out = smoothAirSeries(series, 2); // 2h window = 7200s, inclusive
  assert.deepEqual(out.map((e) => e.air), [10, 15, 20]);
  // i=0 → {10}; i=1 window [-3600,3600] → {10,20}=15; i=2 window [0,7200] → {10,20,30}=20
  assert.deepEqual(out.map((e) => e.windSpeed), [1, 2, 3]); // other fields preserved
  assert.equal(out[0].epoch, 0); // epoch preserved
  assert.notEqual(out, series); // new array, not mutated in place
});

test("smoothAirSeries drops entries older than the window", () => {
  const series = [
    { epoch: 0, air: 10 },
    { epoch: 3600, air: 20 },
    { epoch: 100000, air: 30 }, // far in the future — window holds only itself
  ];
  const out = smoothAirSeries(series, 2);
  assert.equal(out[2].air, 30); // 100000 window = [92800,100000]; earlier entries excluded
});

test("smoothAirSeries averages only non-null airs; empty window → null", () => {
  const series = [
    { epoch: 0, air: null },
    { epoch: 3600, air: 20 },
  ];
  const out = smoothAirSeries(series, 2);
  assert.equal(out[0].air, null); // window holds only its own null → null
  assert.equal(out[1].air, 20); // null neighbor skipped, mean of {20}
});

test("smoothAirSeries on a single element returns its own air", () => {
  assert.deepEqual(smoothAirSeries([{ epoch: 5, air: 12.5 }], 24), [{ epoch: 5, air: 12.5 }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — `smoothAirSeries is not a function` (import is undefined).

- [ ] **Step 3: Write the implementation**

In `scripts/lib.js`, add `SMOOTH_WINDOW_H` to the tunables block (right after `export const FALLBACK_ERR = 0.5;`):

```js
export const SMOOTH_WINDOW_H = 24;   // trailing-mean window for the air driver
```

Then add the helper (place it just before `fitRelaxation`, after `extractForecastSeries`):

```js
// Replace each entry's `air` with the trailing mean of air over the preceding
// `windowH` hours (inclusive of the entry itself), preserving every other field.
// Only non-null airs contribute; an entry whose window holds no non-null air gets
// air: null. Input must be epoch-ascending. This is the model's slow driver — it
// removes the diurnal swing that water can't follow, so the fit isn't diluted.
export function smoothAirSeries(series, windowH = SMOOTH_WINDOW_H) {
  const windowS = windowH * 3600;
  return series.map((entry, i) => {
    const lo = entry.epoch - windowS;
    let sum = 0;
    let count = 0;
    for (let j = i; j >= 0; j--) {
      if (series[j].epoch < lo) break;
      if (series[j].air == null) continue;
      sum += series[j].air;
      count += 1;
    }
    return { ...entry, air: count > 0 ? sum / count : null };
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib.test.js`
Expected: PASS (new `smoothAirSeries` tests + all pre-existing).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: smoothAirSeries trailing-mean air driver + SMOOTH_WINDOW_H

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 2: `fitRelaxation` fits `a, b` only (drop the `c` intercept)

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Produces: `fitRelaxation(readings, opts) -> { a, b, c, n, ok }` where `c` is **always `0`**. Fits `dWater/dt = a*(air - water) + b*windSpeed` (no intercept) by least squares over consecutive in-range pairs. `ok` requires finite `a, b` and `a > 0`; otherwise returns `{ a: 0, b: 0, c: 0, n, ok: false }`. Callers pass **already-smoothed** readings (`.air` is the trailing-mean value); `fitRelaxation` itself is unaware of smoothing.
- Note: `rollForward`, `backtestError`, and their tests are unchanged — they still accept a `coeffs.c` and integrate it; with the new fit `c` is simply `0`.

- [ ] **Step 1: Update the existing fit test and add the no-intercept test**

In `test/lib.test.js`, replace the test `"fitRelaxation recovers the coefficients that generated the data"` (currently generating data with `c: -0.002`) with:

```js
test("fitRelaxation recovers a and b and always reports c:0", () => {
  // Data generated with c:0 (no intercept), so an intercept-free fit must recover a,b.
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0, n: 300 });
  const fit = fitRelaxation(r);
  assert.ok(fit.ok);
  assert.ok(Math.abs(fit.a - 0.05) < 1e-3, `a=${fit.a}`);
  assert.ok(Math.abs(fit.b - 0.01) < 1e-3, `b=${fit.b}`);
  assert.equal(fit.c, 0); // the model no longer fits an intercept
});

test("fitRelaxation never fits an intercept even when the data drifts", () => {
  // True rate carries a +0.05/h drift the model cannot represent; c must stay 0.
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0.05, n: 300 });
  const fit = fitRelaxation(r);
  assert.equal(fit.c, 0);
});
```

Leave the other three `fitRelaxation` tests (`ok:false below MIN_PAIRS`, `ok:false on a non-physical fit`, `skips pairs with an out-of-range time gap`) unchanged — they already use `c: 0` data and assert `ok`/`n` behavior that still holds.

- [ ] **Step 2: Run tests to verify the new expectations fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — the current 3-parameter fit returns a non-zero `fit.c`, so `assert.equal(fit.c, 0)` fails.

- [ ] **Step 3: Replace `solve3`/`det3` with `solve2` and rewrite the fit**

In `scripts/lib.js`, delete the now-unused `det3` and `solve3` functions (the block from `// 3x3 determinant.` through the end of `solve3`) and replace them with a 2×2 solver:

```js
// Solve a 2x2 system Ax = y by Cramer's rule. Returns [x0,x1] or null when the
// system is singular/near-singular.
function solve2(A, y) {
  const d = A[0][0] * A[1][1] - A[0][1] * A[1][0];
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  return [
    (y[0] * A[1][1] - A[0][1] * y[1]) / d,
    (A[0][0] * y[1] - y[0] * A[1][0]) / d,
  ];
}
```

Then replace the body of `fitRelaxation` (keep its signature and the leading `minGap`/`maxGap`/`minPairs` reads) with:

```js
export function fitRelaxation(readings, opts = {}) {
  const minGap = opts.minGapS ?? MIN_GAP_S;
  const maxGap = opts.maxGapS ?? MAX_GAP_S;
  const minPairs = opts.minPairs ?? MIN_PAIRS;
  const S = [[0, 0], [0, 0]];
  const rhs = [0, 0];
  let n = 0;
  for (let i = 0; i < readings.length - 1; i++) {
    const r0 = readings[i];
    const r1 = readings[i + 1];
    const gap = r1.epoch - r0.epoch;
    if (gap < minGap || gap > maxGap) continue;
    if (r0.water == null || r1.water == null || r0.air == null || r0.windSpeed == null) continue;
    const dtH = gap / 3600;
    const rate = (r1.water - r0.water) / dtH;
    const x = [r0.air - r0.water, r0.windSpeed]; // no intercept column
    for (let a = 0; a < 2; a++) {
      for (let b = 0; b < 2; b++) S[a][b] += x[a] * x[b];
      rhs[a] += x[a] * rate;
    }
    n++;
  }
  if (n < minPairs) return { a: 0, b: 0, c: 0, n, ok: false };
  const sol = solve2(S, rhs);
  if (!sol) return { a: 0, b: 0, c: 0, n, ok: false };
  const [a, b] = sol;
  const ok = Number.isFinite(a) && Number.isFinite(b) && a > 0;
  return { a: ok ? a : 0, b: ok ? b : 0, c: 0, n, ok };
}
```

Also update the doc comment above `fitRelaxation` to describe the two-parameter (no-intercept) fit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib.test.js`
Expected: PASS. The updated `fitRelaxation` tests pass; `rollForward`/`backtestError` tests still pass (they pass explicit coeffs and are untouched). The three `buildProjection` tests still pass for now (they will be replaced in Task 3).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: fitRelaxation fits a,b only (drop the c intercept)

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 3: `buildProjection` drives the roll-forward with smoothed, seam-aware air

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `smoothAirSeries` (Task 1), `fitRelaxation` returning `c: 0` (Task 2), and the unchanged `rollForward`/`backtestError`/`interpError`/`round1`.
- Produces: `buildProjection(history, forecastSeries, opts) -> { horizonH, model, coeffs, backtest, points }` (unchanged shape). New behavior: the fit and backtest run on `smoothAirSeries(history)`; the roll-forward driver is `smoothAirSeries(historyTail ++ forecastSeries)` restricted to `epoch > seed.epoch`; each point's displayed `air`/`windSpeed`/`windDir` come from the **raw** `forecastSeries` (seed point from the last history reading). `opts.smoothWindowH` overrides `SMOOTH_WINDOW_H` for testing.

- [ ] **Step 1: Add a constant-air generator and replace the buildProjection tests**

In `test/lib.test.js`, add this generator next to the existing `synthReadings` helper:

```js
// Readings with CONSTANT air (so 24h smoothing is an identity) and water relaxing
// toward it, generated from the exact no-intercept model. Wind varies so b is
// identifiable. Used for buildProjection tests where the smoothed driver == raw.
function synthConst({ a, b, air = 10, n, dtS = 1200, w0 = 15, epoch0 = 1_700_000_000 }) {
  const readings = [];
  let w = w0;
  let epoch = epoch0;
  for (let i = 0; i < n; i++) {
    const windSpeed = 2 + Math.abs(Math.sin(i / 7));
    readings.push({ epoch, water: w, air, windSpeed, windDir: 200 });
    const dtH = dtS / 3600;
    w = w + dtH * (a * (air - w) + b * windSpeed);
    epoch += dtS;
  }
  return readings;
}
```

Then **replace all three existing `buildProjection` tests** (`"buildProjection produces a relaxation payload with a widening band"`, `"buildProjection falls back to flat persistence on a non-physical fit"`, and `"buildProjection attaches air/windSpeed/windDir ..."`) with:

```js
test("buildProjection produces a relaxation payload with a bracketing band and c:0 coeffs", () => {
  // n=400 → ~133h of history so the 48h backtest horizon has samples (mae48 is a number).
  const history = synthConst({ a: 0.05, b: 0.01, air: 10, n: 400 });
  const seed = history[history.length - 1];
  const forecastSeries = Array.from({ length: 48 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 10,
    windSpeed: 2,
    windDir: 180,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.model, "relaxation");
  assert.ok(p.coeffs && p.coeffs.a > 0);
  assert.equal(p.coeffs.c, 0); // intercept dropped
  assert.equal(p.horizonH, 48);
  assert.equal(p.points[0].epoch, seed.epoch); // seed first
  assert.equal(p.points[0].lower, p.points[0].upper); // zero-width band at the seed
  for (const pt of p.points) assert.ok(pt.lower <= pt.water && pt.water <= pt.upper);
  assert.equal(typeof p.backtest.mae48, "number");
});

test("buildProjection drives the roll-forward with the SMOOTHED air, damping a forecast spike", () => {
  // History air steady at 10 (24h+ of it); water relaxes to ~10. Forecast air
  // jumps to 30 instantly. The seam-smoothed driver averages the recent 10s with
  // the new 30, so the first projected step barely moves — far less than a
  // raw-instantaneous-air roll-forward with the same coeffs would.
  const history = synthConst({ a: 0.05, b: 0, air: 10, n: 100 }); // 100*20min ≈ 33h
  const seed = history[history.length - 1];
  const forecastSeries = Array.from({ length: 6 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 30,
    windSpeed: 0,
    windDir: 180,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.ok(p.coeffs && p.coeffs.a > 0);
  // Reference: roll the SAME coeffs forward on the RAW (unsmoothed) forecast air.
  const rawRoll = rollForward({ epoch: seed.epoch, water: seed.water }, forecastSeries, p.coeffs);
  const smoothedStep = Math.abs(p.points[1].water - p.points[0].water);
  const rawStep = Math.abs(rawRoll[0].water - seed.water);
  assert.ok(smoothedStep < rawStep, `smoothed step ${smoothedStep} should be < raw step ${rawStep}`);
});

test("buildProjection seam smoothing includes the history tail (not a cold start)", () => {
  // If the first forecast point's driver ignored history, its smoothed air would
  // equal the first forecast air (30). Because the 24h tail of 10s is included,
  // the effective driver is far below 30 — provable via the damped first step:
  // water must move DOWN toward ~10, not UP toward 30.
  const history = synthConst({ a: 0.05, b: 0, air: 10, n: 100 });
  const seed = history[history.length - 1]; // seed water ~10.x, below 30
  const forecastSeries = Array.from({ length: 3 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 30,
    windSpeed: 0,
    windDir: 180,
  }));
  const p = buildProjection(history, forecastSeries);
  // A cold-started (forecast-only) driver would pull water UP toward 30.
  assert.ok(p.points[1].water <= p.points[0].water + 0.1,
    `first step ${p.points[1].water} vs seed ${p.points[0].water} — tail should hold the driver near 10`);
});

test("buildProjection stores RAW forecast air/wind on points (smoothing is model-internal)", () => {
  const history = synthConst({ a: 0.05, b: 0.01, air: 10, n: 120 });
  const seed = history[history.length - 1];
  seed.windDir = 210; // last observed reading carries a bearing
  const forecastSeries = Array.from({ length: 3 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 18 + i, // raw forecast air, varies — must appear verbatim on points
    windSpeed: 4 + i,
    windDir: 90 + i,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.points[0].air, seed.air); // seed shows the last observed air
  assert.equal(p.points[0].windSpeed, seed.windSpeed);
  assert.equal(p.points[0].windDir, 210);
  assert.equal(p.points[1].air, 18); // first forecast point shows RAW forecast air, not smoothed
  assert.equal(p.points[1].windSpeed, 4);
  assert.equal(p.points[1].windDir, 90);
});

test("buildProjection falls back to flat persistence on a non-physical fit", () => {
  const history = synthConst({ a: 0, b: 0, air: 10, n: 120 }); // flat water → fit not ok
  const seed = history[history.length - 1];
  const forecastSeries = [
    { epoch: seed.epoch + 3600, air: 30, windSpeed: 9, windDir: 10 },
    { epoch: seed.epoch + 7200, air: 2, windSpeed: 0, windDir: 20 },
  ];
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.model, "persistence");
  assert.equal(p.coeffs, null);
  assert.equal(p.points[1].water, p.points[0].water); // flat despite wild air/wind
  assert.equal(p.points[2].water, p.points[0].water);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — the current `buildProjection` uses raw instantaneous air, so the "SMOOTHED air damps the spike" and "seam smoothing" tests fail (the first step moves up toward 30, not down).

- [ ] **Step 3: Rewrite `buildProjection`**

In `scripts/lib.js`, replace the entire `buildProjection` function body with:

```js
export function buildProjection(history, forecastSeries, opts = {}) {
  const horizonH = opts.horizonH ?? HORIZON_H;
  const windowH = opts.smoothWindowH ?? SMOOTH_WINDOW_H;
  const seed = history[history.length - 1];
  // Fit and backtest on a history whose air is the trailing-mean driver, so the
  // coupling reflects the slow signal water actually follows (not the diurnal wobble).
  const smoothHist = smoothAirSeries(history, windowH);
  const fit = fitRelaxation(smoothHist);
  const coeffs = fit.ok ? { a: fit.a, b: fit.b, c: fit.c } : { a: 0, b: 0, c: 0 };
  const err = backtestError(smoothHist, coeffs, BACKTEST_HORIZONS);
  // Roll-forward driver: smooth air ACROSS THE SEAM so the first `windowH` hours
  // of forecast average real observations rather than cold-starting. Concatenate
  // the recent history tail with the forecast, smooth, then keep the forecast
  // portion (its air is now the trailing mean; its wind stays the raw forecast wind).
  const tail = history
    .filter((r) => r.epoch > seed.epoch - windowH * 3600 && r.epoch <= seed.epoch)
    .map((r) => ({ epoch: r.epoch, air: r.air, windSpeed: r.windSpeed }));
  const combined = tail.concat(forecastSeries).sort((x, y) => x.epoch - y.epoch);
  const smoothedForecast = smoothAirSeries(combined, windowH).filter((f) => f.epoch > seed.epoch);
  const rolled = rollForward({ epoch: seed.epoch, water: seed.water }, smoothedForecast, coeffs, { horizonH });
  // Displayed air/wind stay the RAW met.no forecast (smoothing is internal to the
  // water model). Keyed by epoch to stamp each rolled point.
  const weather = new Map(forecastSeries.map((f) => [f.epoch, f]));
  const points = [{
    epoch: seed.epoch,
    water: round1(seed.water),
    lower: round1(seed.water),
    upper: round1(seed.water),
    air: seed.air ?? null,
    windSpeed: seed.windSpeed ?? null,
    windDir: seed.windDir ?? null,
  }];
  for (const p of rolled) {
    const h = (p.epoch - seed.epoch) / 3600;
    const e = INFLATE * interpError(err, h);
    const w = weather.get(p.epoch);
    points.push({
      epoch: p.epoch,
      water: round1(p.water),
      lower: round1(p.water - e),
      upper: round1(p.water + e),
      air: w?.air ?? null,
      windSpeed: w?.windSpeed ?? null,
      windDir: w?.windDir ?? null,
    });
  }
  return {
    horizonH,
    model: fit.ok ? "relaxation" : "persistence",
    coeffs: fit.ok ? coeffs : null,
    backtest: { mae6: err[6], mae12: err[12], mae24: err[24], mae48: err[48] },
    points,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib.test.js`
Expected: PASS (all tests, including the replaced `buildProjection` tests and every earlier task's tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: drive the water projection with seam-smoothed mean air

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 4: Paginate `fetchHistory` so the fit uses the full window

**Files:**
- Modify: `scripts/poll.js`

**Interfaces:**
- Consumes: nothing new. `fetchHistory()` keeps its signature (`async () -> Array` of `{ epoch, water, air, windSpeed, windDir }`, oldest-first) and its callers in `updateForecast` are unchanged.
- Produces: `fetchHistory` now returns **all** rows within `FIT_WINDOW_DAYS` of now (paginated), not just Supabase's first 1000. `poll.js` has no unit tests by project convention; this task is verified with `node --check` and a deferred live run.

- [ ] **Step 1: Replace the single read with a paginated loop**

In `scripts/poll.js`, replace the entire `fetchHistory` function with:

```js
// Fetch the recent reading history for the fit (oldest-first), mapped to the
// camelCase shape the model helpers expect. Paginates so the fit sees the whole
// FIT_WINDOW_DAYS window rather than Supabase's default 1000-row read cap.
// Returns [] on any failure.
async function fetchHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - FIT_WINDOW_DAYS * 86400;
  const PAGE = 1000;
  const MAX_PAGES = 50; // safety cap (50k rows ≫ any FIT_WINDOW_DAYS window)
  const rows = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        `${SUPABASE_URL}/rest/v1/readings` +
        `?select=epoch,water,air,wind_speed,wind_dir&location_id=eq.${STORAGE_ID}` +
        `&epoch=gte.${cutoff}&order=epoch.desc&limit=${PAGE}&offset=${page * PAGE}`;
      // Newest-first so a partial fetch keeps the most recent rows; reversed below.
      const res = await fetch(url, {
        headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      });
      if (!res.ok) {
        console.error(`History query failed: ${res.status} ${res.statusText}`);
        return [];
      }
      const batch = await res.json();
      rows.push(...batch);
      if (batch.length < PAGE) break; // last page reached
    }
    // rows are newest-first (epoch.desc); reverse to oldest-first so the model
    // fits over consecutive pairs and buildProjection seeds from the newest row.
    return rows
      .map((r) => ({ epoch: r.epoch, water: r.water, air: r.air, windSpeed: r.wind_speed, windDir: r.wind_dir }))
      .reverse();
  } catch (err) {
    console.error(`Network error fetching history: ${err.message}`);
    return [];
  }
}
```

- [ ] **Step 2: Verify syntax and the suite**

Run: `node --check scripts/poll.js`
Expected: no output (valid syntax).

Run: `npm test`
Expected: full suite green (unchanged — `poll.js` has no unit tests).

- [ ] **Step 3: Live run (deferred to the human)**

`poll.js` is I/O and untested by convention. This step is **deferred to the human**: run the poller against Supabase and confirm the history now spans ~`FIT_WINDOW_DAYS` and a projection is still produced. The implementer should NOT attempt this; note it as deferred in the report.

```bash
[YR_API_KEY=<key>] SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js
# expect: "Projection updated: model=relaxation, points=49" (or similar; points > 1)
```

- [ ] **Step 4: Commit**

```bash
git add scripts/poll.js
git commit -m "fix: paginate fetchHistory so the fit uses the full window

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 5: Update `CLAUDE.md` for the mean-air model

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the behavior implemented in Tasks 1–4.
- Produces: docs that match the shipped model. Documentation-only; no code, no tests.

- [ ] **Step 1: Update the Forecast architecture bullet**

In `CLAUDE.md`, in the `### Forecast` architecture bullet, update the model description so it reads that `lib.js` fits a relaxation model `dWater/dt = a·(air−water) + b·wind` (no intercept) against a **24-hour trailing-mean air** driver (`smoothAirSeries`, `SMOOTH_WINDOW_H`) rather than instantaneous air, smoothing across the history→forecast seam; note that the air/wind lines shown to the user remain the raw met.no forecast (smoothing is internal to the water model). Keep the existing description of `fitRelaxation`/`rollForward`/`backtestError`/`buildProjection` and the persistence fallback.

- [ ] **Step 2: Update the Config knobs**

In `CLAUDE.md`, under "Forecast model tunables", add `SMOOTH_WINDOW_H` to the list of constants in `scripts/lib.js`. Also note (where the poller/history is described) that `fetchHistory` paginates so the fit uses the full `FIT_WINDOW_DAYS` window rather than Supabase's 1000-row read cap.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe the mean-air projection model and history pagination

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Self-Review

**Spec coverage:**
- 24h trailing-mean air driver (`SMOOTH_WINDOW_H`, `smoothAirSeries`) → Task 1. ✓
- Drop the `c` intercept (fit `a, b`; `c: 0`) → Task 2. ✓
- Fit + backtest on smoothed history; seam-smoothed roll-forward driver; raw air/wind on displayed points → Task 3. ✓
- Payload shape unchanged; no `app.js`/`data.js`/schema edits → Task 3 preserves the point/payload shape; File Structure excludes those files. ✓
- Persistence fallback preserved → Task 3 test + code (`fit.ok` gate). ✓
- Band still sized from backtest × `INFLATE` → Task 3 keeps `interpError`/`INFLATE` unchanged. ✓
- `fetchHistory` pagination (row-cap fix), bounded by `FIT_WINDOW_DAYS` → Task 4. ✓
- Docs updated → Task 5. ✓
- TDD, zero deps, commit trailer → every code task is test-first (except the untested-by-convention `poll.js`); no packages; trailer on every commit. ✓

**Placeholder scan:** none — every code step shows complete code. The two "describe/update" doc steps (Task 5) are prose edits to an existing file, not code placeholders. ✓

**Type consistency:**
- `smoothAirSeries(series, windowH)` returns the same-shape array with `air` replaced; consumed by `buildProjection` for both the fit (`smoothHist`) and the seam driver (`smoothedForecast`). ✓
- `fitRelaxation` returns `{ a, b, c: 0, n, ok }`; `buildProjection` reads `fit.a/b/c` and gates on `fit.ok`; `rollForward`/`backtestError` still receive `{ a, b, c }` and integrate `c` (0). ✓
- `solve2(A, y)` (2×2) replaces `solve3`; only `fitRelaxation` used `solve3`, so removing `det3`/`solve3` leaves no dangling references. ✓
- Payload/point shape identical to the pre-change code (`{ epoch, water, lower, upper, air, windSpeed, windDir }`; `{ horizonH, model, coeffs, backtest, points }`), so the browser contract holds. ✓
- `synthConst` (Task 3 test helper) emits `{ epoch, water, air, windSpeed, windDir }`, matching what `buildProjection`/`smoothAirSeries`/`fitRelaxation` consume. ✓
