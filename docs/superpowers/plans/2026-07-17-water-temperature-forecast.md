# 48-hour Water-Temperature Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project water temperature 48 hours ahead from a relaxation model fit on stored history, and render it as a dashed line with a confidence band that widens with the horizon.

**Architecture:** The poller fits `dWater/dt = a·(air−water) + b·wind + c` from ~30 days of history, rolls it forward on the met.no forecast it fetches, backtests to size a confidence band, and upserts one JSON row into a new `forecast` table (replace-on-write). The browser adds one parallel fetch and draws a dashed line + shaded band. All model math is pure and lives in `scripts/lib.js`; the browser mapper is pure and lives in `src/data.js`.

**Tech Stack:** Node 20+ (`node --test`, zero deps), native ES modules, Supabase PostgREST, ECharts (CDN). No new dependencies — the OLS fit is closed-form and solved in-repo.

## Global Constraints

- **Zero dependencies.** No npm packages — pure JS only (Node built-ins / browser globals). Verbatim from the spec: "No ML / dependency — the model is closed-form OLS solved in-repo."
- **Pure/I-O split preserved.** All model logic goes in `scripts/lib.js` (server) or `src/data.js` (browser), both I/O-free and unit-tested. All network/DOM stays in `scripts/poll.js` / `app.js`.
- **Append-only `readings` invariant untouched.** The new `forecast` table uses a *replace* (upsert) write pattern in its own table; the `readings` table and its `Prefer: resolution=ignore-duplicates` path are not changed.
- **Fail soft.** A forecast failure (met.no, history query, or upsert) must never affect the reading insert or blank the chart — it just omits the projection.
- **Horizon = 48h. Band inflation = 1.3×.** `INFLATE = 1.3` on the backtest error; band is documented as an approximation, not a calibrated interval.
- **All commits** end with the trailer `Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe`.
- **Norwegian UI labels**, times in `Europe/Oslo` (existing convention — the projection series label is Norwegian).

---

## File Structure

- `supabase/schema.sql` — **modify**: add the `forecast` table + RLS policy.
- `scripts/lib.js` — **modify**: add pure model helpers + constants (`extractForecastSeries`, `fitRelaxation`, `rollForward`, `backtestError`, `buildProjection`, and internal `det3`/`solve3`/`nearestByEpoch`/`interpError`/`round1`).
- `scripts/poll.js` — **modify**: add `fetchHistory`, `upsertForecast`, `updateForecast`; call `updateForecast()` from `main()`.
- `src/data.js` — **modify**: add `forecastQueryUrl` and `mapForecast`.
- `app.js` — **modify**: add `loadForecast`, thread `forecast` into `buildOption`/`render`/`refresh`/`init`, add the dashed line + band series and tooltip filter.
- `test/lib.test.js` — **modify**: tests for the five new pure server helpers.
- `test/data.test.js` — **modify**: tests for `forecastQueryUrl` and `mapForecast`.
- `CLAUDE.md` — **modify**: document the forecast half.

---

## Task 1: `forecast` table schema

**Files:**
- Modify: `supabase/schema.sql`

**Interfaces:**
- Produces: a `forecast` table `(location_id text primary key, generated_at timestamptz, payload jsonb)` with public `anon` SELECT — the upsert target for Task 7 and the read source for Task 8.

- [ ] **Step 1: Append the table + policy to the schema**

Add to the end of `supabase/schema.sql`:

```sql
-- Latest 48h water-temperature projection, one row per location, REPLACED on
-- every poll (upsert on the location_id primary key). This is NOT append-only —
-- it deliberately differs from `readings`; only the newest projection is kept.
create table if not exists forecast (
  location_id  text primary key,
  generated_at timestamptz not null,
  payload      jsonb not null
);
-- payload shape (built by buildProjection in scripts/lib.js):
--   { horizonH, model: "relaxation"|"persistence", coeffs: {a,b,c}|null,
--     backtest: {mae6,mae12,mae24,mae48},
--     points: [ { epoch, water, lower, upper }, ... ] }

-- Public read-only access for the static chart (anon = publishable key). Writes
-- use the service_role key, which bypasses RLS.
alter table forecast enable row level security;

create policy "Public read access"
  on forecast
  for select
  to anon
  using (true);
```

- [ ] **Step 2: Verify the SQL parses locally (sanity only — no DB here)**

Run: `grep -c "create table if not exists forecast" supabase/schema.sql`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add forecast table for water-temp projections

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

> **Manual apply (not a code step):** this DDL must be run once in the Supabase SQL editor before Task 7's poller can upsert. Note it in the execution handoff.

---

## Task 2: `extractForecastSeries` — read future air/wind from met.no

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: a met.no Locationforecast 2.0 `complete` JSON (same response `poll.js` already fetches).
- Produces: `extractForecastSeries(json) -> Array<{ epoch:number, air:number, windSpeed:number }>` in ascending time order, skipping entries missing a numeric `air_temperature`. `windSpeed` may be null. `epoch` is seconds from the entry's `time`.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.js` (import `extractForecastSeries` in the top `import` block):

```js
const METNO_SAMPLE = {
  properties: {
    timeseries: [
      { time: "2026-07-17T10:00:00Z", data: { instant: { details: { air_temperature: 21.0, wind_speed: 2.5 } } } },
      { time: "2026-07-17T11:00:00Z", data: { instant: { details: { air_temperature: 21.6, wind_speed: 3.1 } } } },
      { time: "2026-07-17T12:00:00Z", data: { instant: { details: {} } } }, // no air → skipped
    ],
  },
};

test("extractForecastSeries returns ascending {epoch,air,windSpeed}, skipping entries with no air", () => {
  const series = extractForecastSeries(METNO_SAMPLE);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], {
    epoch: Math.floor(Date.parse("2026-07-17T10:00:00Z") / 1000),
    air: 21.0,
    windSpeed: 2.5,
  });
  assert.equal(series[1].air, 21.6);
  assert.ok(series[0].epoch < series[1].epoch);
});

test("extractForecastSeries returns [] for a malformed response", () => {
  assert.deepEqual(extractForecastSeries({}), []);
  assert.deepEqual(extractForecastSeries(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `extractForecastSeries is not a function` / import error.

- [ ] **Step 3: Write the implementation**

Append to `scripts/lib.js`:

```js
// Pull the forward air/wind timeseries from a met.no Locationforecast 2.0
// response, as ascending {epoch, air, windSpeed}. Entries without a numeric
// air_temperature are skipped (they can't drive the relaxation model); windSpeed
// falls back to null. Unlike extractForecast (which keeps only hour 0), this
// returns every entry — the projection roll-forward bounds it to the horizon.
export function extractForecastSeries(json) {
  const series = json?.properties?.timeseries;
  if (!Array.isArray(series)) return [];
  const out = [];
  for (const entry of series) {
    const details = entry?.data?.instant?.details;
    const air = num(details?.air_temperature);
    if (air == null) continue;
    const epoch = Math.floor(Date.parse(entry.time) / 1000);
    if (!Number.isFinite(epoch)) continue;
    out.push({ epoch, air, windSpeed: num(details?.wind_speed) });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS (all tests, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: extractForecastSeries reads future air/wind from met.no

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 3: `fitRelaxation` — OLS fit of the relaxation model

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `readings: Array<{ epoch, water, air, windSpeed }>` oldest-first (camelCase; the poller maps DB rows to this in Task 7).
- Produces:
  - Exported constants: `FIT_WINDOW_DAYS=30`, `MIN_GAP_S=300`, `MAX_GAP_S=5400`, `MIN_PAIRS=50`, `HORIZON_H=48`, `INFLATE=1.3`, `BACKTEST_HORIZONS=[6,12,24,48]`, `BACKTEST_STRIDE=6`, `FALLBACK_ERR=0.5`.
  - `fitRelaxation(readings, opts?) -> { a, b, c, n, ok }`. `ok` is false when usable pairs `< MIN_PAIRS`, the system is singular, or the fit is non-physical (`a ≤ 0` / non-finite). On `!ok`, `a/b/c` are `0`.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.js` (import `fitRelaxation`). Include this synthetic-data generator near the top of the file (it's reused by Tasks 4–6):

```js
// Generate readings by forward-integrating the exact relaxation model, so an
// OLS fit must recover (a,b,c) to numerical precision. dtS default = 20 min.
function synthReadings({ a, b, c, n, dtS = 1200, w0 = 15, epoch0 = 1_700_000_000 }) {
  const readings = [];
  let w = w0;
  let epoch = epoch0;
  for (let i = 0; i < n; i++) {
    const air = 20 + 5 * Math.sin(i / 10);
    const windSpeed = 2 + Math.abs(Math.sin(i / 7));
    readings.push({ epoch, water: w, air, windSpeed });
    const dtH = dtS / 3600;
    w = w + dtH * (a * (air - w) + b * windSpeed + c);
    epoch += dtS;
  }
  return readings;
}
```

```js
test("fitRelaxation recovers the coefficients that generated the data", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: -0.002, n: 300 });
  const fit = fitRelaxation(r);
  assert.ok(fit.ok);
  assert.ok(Math.abs(fit.a - 0.05) < 1e-3, `a=${fit.a}`);
  assert.ok(Math.abs(fit.b - 0.01) < 1e-3, `b=${fit.b}`);
  assert.ok(Math.abs(fit.c - -0.002) < 1e-3, `c=${fit.c}`);
});

test("fitRelaxation returns ok:false below MIN_PAIRS usable pairs", () => {
  const fit = fitRelaxation(synthReadings({ a: 0.05, b: 0.01, c: 0, n: 10 }));
  assert.equal(fit.ok, false);
});

test("fitRelaxation returns ok:false on a non-physical fit (flat water → a≤0)", () => {
  // Constant water with varying air/wind: rate is 0 everywhere → a fits to ~0.
  const r = synthReadings({ a: 0, b: 0, c: 0, n: 200 });
  const fit = fitRelaxation(r);
  assert.equal(fit.ok, false);
});

test("fitRelaxation skips pairs with an out-of-range time gap", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0, n: 120 });
  r[60].epoch += 3 * 86400; // huge gap around index 60 → that pair excluded
  const fit = fitRelaxation(r);
  assert.ok(fit.ok);
  assert.ok(fit.n < r.length - 1); // at least one pair dropped
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `fitRelaxation is not a function`.

- [ ] **Step 3: Write the implementation**

Add the constants block near the top of `scripts/lib.js` (just under the `num` helper):

```js
// --- Forecast model tunables ------------------------------------------------
export const FIT_WINDOW_DAYS = 30;   // history window queried for the fit
export const MIN_GAP_S = 300;        // ignore consecutive pairs closer than 5 min
export const MAX_GAP_S = 5400;       // ...or farther apart than 90 min (feed gaps)
export const MIN_PAIRS = 50;         // min usable pairs before the fit is trusted
export const HORIZON_H = 48;         // projection horizon (hours)
export const INFLATE = 1.3;          // band inflation for met.no forecast-input error
export const BACKTEST_HORIZONS = [6, 12, 24, 48];
export const BACKTEST_STRIDE = 6;    // subsample origins ~every 2h at 20-min cadence
export const FALLBACK_ERR = 0.5;     // band half-width (°C) when backtest has no data
```

Append the fit + linear-algebra helpers to `scripts/lib.js`:

```js
// 3x3 determinant.
function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

// Solve Ax = y for a 3x3 A by Cramer's rule. Returns [x0,x1,x2] or null when the
// system is singular/near-singular.
function solve3(A, y) {
  const d = det3(A);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const withCol = (j) => A.map((row, i) => row.map((v, k) => (k === j ? y[i] : v)));
  return [det3(withCol(0)) / d, det3(withCol(1)) / d, det3(withCol(2)) / d];
}

// Least-squares fit of dWater/dt = a*(air-water) + b*windSpeed + c over
// consecutive reading pairs. Only pairs with a sane time gap and all predictors
// present contribute. Returns {a,b,c,n,ok}; ok gates the caller into the
// persistence fallback when the fit is untrustworthy or non-physical (a<=0).
export function fitRelaxation(readings, opts = {}) {
  const minGap = opts.minGapS ?? MIN_GAP_S;
  const maxGap = opts.maxGapS ?? MAX_GAP_S;
  const minPairs = opts.minPairs ?? MIN_PAIRS;
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < readings.length - 1; i++) {
    const r0 = readings[i];
    const r1 = readings[i + 1];
    const gap = r1.epoch - r0.epoch;
    if (gap < minGap || gap > maxGap) continue;
    if (r0.water == null || r1.water == null || r0.air == null || r0.windSpeed == null) continue;
    const dtH = gap / 3600;
    const rate = (r1.water - r0.water) / dtH;
    const x = [r0.air - r0.water, r0.windSpeed, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) S[a][b] += x[a] * x[b];
      rhs[a] += x[a] * rate;
    }
    n++;
  }
  if (n < minPairs) return { a: 0, b: 0, c: 0, n, ok: false };
  const sol = solve3(S, rhs);
  if (!sol) return { a: 0, b: 0, c: 0, n, ok: false };
  const [a, b, c] = sol;
  const ok = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && a > 0;
  return { a: ok ? a : 0, b: ok ? b : 0, c: ok ? c : 0, n, ok };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: fitRelaxation — OLS fit of the water relaxation model

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 4: `rollForward` — integrate the model along a forecast

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `seed: { epoch, water }`, `forecastSeries: Array<{ epoch, air, windSpeed }>` (ascending), `coeffs: { a, b, c }`, `opts?: { horizonH }`.
- Produces: `rollForward(seed, forecastSeries, coeffs, opts?) -> Array<{ epoch, water }>` — one projected point per forecast entry with `seed.epoch < epoch ≤ seed.epoch + horizonH·3600` and non-null air/windSpeed. Zero coeffs → a flat (persistence) line.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.js` (import `rollForward`, `HORIZON_H`):

```js
test("rollForward relaxes water toward the forecast air temperature", () => {
  const seed = { epoch: 1000, water: 10 };
  const hourly = Array.from({ length: 5 }, (_, i) => ({
    epoch: 1000 + (i + 1) * 3600,
    air: 20,
    windSpeed: 0,
  }));
  const pts = rollForward(seed, hourly, { a: 0.1, b: 0, c: 0 });
  assert.equal(pts.length, 5);
  // w1 = 10 + 1*(0.1*(20-10)) = 11
  assert.ok(Math.abs(pts[0].water - 11) < 1e-9);
  // monotonically rising toward 20, never overshooting
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].water > pts[i - 1].water);
  assert.ok(pts[pts.length - 1].water < 20);
});

test("rollForward stops at the horizon and ignores past/nullish entries", () => {
  const seed = { epoch: 0, water: 10 };
  const series = [
    { epoch: -3600, air: 20, windSpeed: 1 }, // before seed → ignored
    { epoch: 3600, air: 20, windSpeed: 1 },
    { epoch: 7200, air: null, windSpeed: 1 }, // null air → skipped
    { epoch: (HORIZON_H + 1) * 3600, air: 20, windSpeed: 1 }, // past horizon → excluded
  ];
  const pts = rollForward(seed, series, { a: 0.1, b: 0, c: 0 });
  assert.deepEqual(pts.map((p) => p.epoch), [3600]);
});

test("rollForward with zero coeffs is flat persistence", () => {
  const seed = { epoch: 0, water: 12.3 };
  const series = [{ epoch: 3600, air: 25, windSpeed: 5 }, { epoch: 7200, air: 5, windSpeed: 0 }];
  const pts = rollForward(seed, series, { a: 0, b: 0, c: 0 });
  assert.deepEqual(pts.map((p) => p.water), [12.3, 12.3]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `rollForward is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/lib.js`:

```js
// Integrate dWater/dt = a*(air-water) + b*windSpeed + c forward from `seed`
// along the forecast timestamps (Euler step, variable dt). Because each step
// relaxes toward that hour's forecast air, the trajectory self-corrects and
// stays stable. Zero coeffs yield a flat line (persistence baseline).
export function rollForward(seed, forecastSeries, coeffs, opts = {}) {
  const horizonH = opts.horizonH ?? HORIZON_H;
  const { a, b, c } = coeffs;
  const cutoff = seed.epoch + horizonH * 3600;
  let w = seed.water;
  let tPrev = seed.epoch;
  const out = [];
  for (const f of forecastSeries) {
    if (f.epoch <= seed.epoch) continue;
    if (f.epoch > cutoff) break;
    if (f.air == null || f.windSpeed == null) continue;
    const dtH = (f.epoch - tPrev) / 3600;
    if (dtH <= 0) continue;
    w = w + dtH * (a * (f.air - w) + b * f.windSpeed + c);
    out.push({ epoch: f.epoch, water: w });
    tPrev = f.epoch;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: rollForward integrates the model along a forecast

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 5: `backtestError` — per-horizon model error

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `readings: Array<{ epoch, water, air, windSpeed }>` (oldest-first), `coeffs: { a, b, c }`, `horizonsH?: number[]`, `opts?: { stride, toleranceS }`.
- Produces: `backtestError(readings, coeffs, horizonsH?, opts?) -> { [h:number]: number|null }` — mean absolute error (°C) at each horizon, computed walk-forward using the *actual* later readings as the driver (a model-error proxy, optimistic vs true forecast error — hence the 1.3× inflation applied later). `null` for a horizon with no usable samples.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.js` (import `backtestError`, `fitRelaxation`):

```js
test("backtestError is ~0 when the model reproduces the data exactly", () => {
  const coeffs = { a: 0.05, b: 0.01, c: -0.002 };
  const r = synthReadings({ ...coeffs, n: 600 });
  const err = backtestError(r, coeffs, [6, 12, 24]);
  for (const h of [6, 12, 24]) {
    assert.ok(err[h] != null, `err[${h}] should have samples`);
    assert.ok(err[h] < 0.05, `err[${h}]=${err[h]} should be tiny`);
  }
});

test("backtestError with zero coeffs (persistence) has positive error on drifting water", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0.01, n: 600 });
  const err = backtestError(r, { a: 0, b: 0, c: 0 }, [24]);
  assert.ok(err[24] > 0.1, `persistence error ${err[24]} should be sizeable`);
});

test("backtestError returns null for a horizon with no samples", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0, n: 20 });
  const err = backtestError(r, { a: 0.05, b: 0.01, c: 0 }, [48]);
  assert.equal(err[48], null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `backtestError is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/lib.js`:

```js
// Nearest entry to `t` (seconds) within `tolS`, by |epoch - t|. Linear scan —
// arrays here are at most a few thousand rows, called from a background poll.
function nearestByEpoch(arr, t, tolS) {
  let best = null;
  let bestGap = Infinity;
  for (const e of arr) {
    const gap = Math.abs(e.epoch - t);
    if (gap < bestGap) {
      bestGap = gap;
      best = e;
    }
  }
  return best && bestGap <= tolS ? best : null;
}

// Walk-forward backtest: from strided origin readings, roll the fitted model
// forward using the ACTUAL later readings as the air/wind driver, and compare
// the projection against the real water reading nearest each horizon. Returns
// mean absolute error per horizon (°C), or null where no samples exist. This
// measures MODEL error only (perfect-input proxy); it does not see met.no's own
// forecast error, so callers inflate the resulting band.
export function backtestError(readings, coeffs, horizonsH = BACKTEST_HORIZONS, opts = {}) {
  const stride = opts.stride ?? BACKTEST_STRIDE;
  const tolS = opts.toleranceS ?? 3600;
  const maxH = Math.max(...horizonsH);
  const sum = {};
  const count = {};
  for (const h of horizonsH) {
    sum[h] = 0;
    count[h] = 0;
  }
  for (let i = 0; i < readings.length; i += stride) {
    const origin = readings[i];
    if (origin.water == null) continue;
    const proj = rollForward(
      { epoch: origin.epoch, water: origin.water },
      readings.slice(i + 1),
      coeffs,
      { horizonH: maxH },
    );
    if (proj.length === 0) continue;
    for (const h of horizonsH) {
      const targetT = origin.epoch + h * 3600;
      const pred = nearestByEpoch(proj, targetT, tolS);
      const actual = nearestByEpoch(readings, targetT, tolS);
      if (pred == null || actual == null || actual.water == null) continue;
      sum[h] += Math.abs(pred.water - actual.water);
      count[h] += 1;
    }
  }
  const out = {};
  for (const h of horizonsH) out[h] = count[h] > 0 ? sum[h] / count[h] : null;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: backtestError — walk-forward per-horizon model error

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 6: `buildProjection` — assemble the payload with a band

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `history: Array<{ epoch, water, air, windSpeed }>` (oldest-first, non-empty), `forecastSeries: Array<{ epoch, air, windSpeed }>`, `opts?: { horizonH }`.
- Produces: `buildProjection(history, forecastSeries, opts?) -> { horizonH, model:"relaxation"|"persistence", coeffs:{a,b,c}|null, backtest:{mae6,mae12,mae24,mae48}, points:Array<{epoch,water,lower,upper}> }`. `points[0]` is the seed (last history reading) with `lower===upper===water` so the band opens from zero width at "now" and the dashed line joins the solid line. Values rounded to 1 decimal.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.js` (import `buildProjection`):

```js
test("buildProjection produces a relaxation payload with a widening band", () => {
  const history = synthReadings({ a: 0.05, b: 0.01, c: -0.002, n: 400 });
  const seed = history[history.length - 1];
  const forecastSeries = Array.from({ length: 48 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 20,
    windSpeed: 2,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.model, "relaxation");
  assert.ok(p.coeffs && p.coeffs.a > 0);
  assert.equal(p.horizonH, 48);
  // first point is the seed with a zero-width band
  assert.equal(p.points[0].epoch, seed.epoch);
  assert.equal(p.points[0].lower, p.points[0].upper);
  // every point brackets its center, band never inverts
  for (const pt of p.points) assert.ok(pt.lower <= pt.water && pt.water <= pt.upper);
  assert.equal(typeof p.backtest.mae48, "number");
});

test("buildProjection falls back to flat persistence on a non-physical fit", () => {
  const history = synthReadings({ a: 0, b: 0, c: 0, n: 300 }); // flat water → fit not ok
  const seed = history[history.length - 1];
  const forecastSeries = [
    { epoch: seed.epoch + 3600, air: 30, windSpeed: 9 },
    { epoch: seed.epoch + 7200, air: 2, windSpeed: 0 },
  ];
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.model, "persistence");
  assert.equal(p.coeffs, null);
  // projected centers are flat at the seed water despite wild air/wind
  assert.equal(p.points[1].water, p.points[0].water);
  assert.equal(p.points[2].water, p.points[0].water);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `buildProjection is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `scripts/lib.js`:

```js
const round1 = (v) => Math.round(v * 10) / 10;

// Linear-interpolate the per-horizon backtest error at hour h, clamped to the
// measured endpoints; falls back to FALLBACK_ERR when no horizon has samples.
function interpError(err, h) {
  const pts = BACKTEST_HORIZONS.filter((k) => err[k] != null).map((k) => [k, err[k]]);
  if (pts.length === 0) return FALLBACK_ERR;
  if (h <= pts[0][0]) return pts[0][1];
  if (h >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i][0]) {
      const [h0, e0] = pts[i - 1];
      const [h1, e1] = pts[i];
      return e0 + ((e1 - e0) * (h - h0)) / (h1 - h0);
    }
  }
  return pts[pts.length - 1][1];
}

// Assemble the stored forecast payload: fit the model (or fall back to flat
// persistence), roll forward on the met.no forecast, and wrap each projected
// point in an INFLATE-scaled backtest band. points[0] is the seed with a
// zero-width band so the dashed line joins the solid line at "now".
export function buildProjection(history, forecastSeries, opts = {}) {
  const horizonH = opts.horizonH ?? HORIZON_H;
  const fit = fitRelaxation(history);
  const coeffs = fit.ok ? { a: fit.a, b: fit.b, c: fit.c } : { a: 0, b: 0, c: 0 };
  const seed = history[history.length - 1];
  const rolled = rollForward({ epoch: seed.epoch, water: seed.water }, forecastSeries, coeffs, { horizonH });
  const err = backtestError(history, coeffs, BACKTEST_HORIZONS);
  const points = [{ epoch: seed.epoch, water: round1(seed.water), lower: round1(seed.water), upper: round1(seed.water) }];
  for (const p of rolled) {
    const h = (p.epoch - seed.epoch) / 3600;
    const e = INFLATE * interpError(err, h);
    points.push({ epoch: p.epoch, water: round1(p.water), lower: round1(p.water - e), upper: round1(p.water + e) });
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: buildProjection assembles the forecast payload with a band

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 7: Poller wiring — fetch history, project, upsert

**Files:**
- Modify: `scripts/poll.js`

**Interfaces:**
- Consumes: `extractForecastSeries`, `buildProjection`, `HORIZON_H`, `FIT_WINDOW_DAYS` from `./lib.js`.
- Produces: `updateForecast()` — fetches met.no `complete`, queries ~30d of history, builds the projection, and upserts one `forecast` row. Called unconditionally near the end of `main()`; fails soft (never throws, never touches the reading insert).

> **Note (accepted):** `updateForecast()` does its own met.no fetch rather than reusing `pollOfficial`'s. This keeps the projection fully decoupled from the water-source path (official *or* the temporary unofficial fallback), at the cost of one extra met.no `complete` request per poll — acceptable at ~20-min cadence, and it means the projection keeps updating even on a poll that inserts no new reading. When the unofficial scaffold is deleted, `updateForecast()` is unaffected.

- [ ] **Step 1: Extend the lib import**

In `scripts/poll.js`, replace the top import block:

```js
import {
  extractOfficialWater,
  extractForecast,
  buildRow,
  extractReading,
  toRow,
} from "./lib.js";
```

with:

```js
import {
  extractOfficialWater,
  extractForecast,
  extractForecastSeries,
  buildRow,
  buildProjection,
  extractReading,
  toRow,
  HORIZON_H,
  FIT_WINDOW_DAYS,
} from "./lib.js";
```

- [ ] **Step 2: Add `fetchHistory`, `upsertForecast`, `updateForecast`**

Insert these three functions in `scripts/poll.js` just above `async function main()`:

```js
// Fetch the recent reading history for the fit (oldest-first), mapped to the
// camelCase shape the model helpers expect. Returns [] on any failure.
async function fetchHistory() {
  const cutoff = Math.floor(Date.now() / 1000) - FIT_WINDOW_DAYS * 86400;
  const url =
    `${SUPABASE_URL}/rest/v1/readings` +
    `?select=epoch,water,air,wind_speed&location_id=eq.${STORAGE_ID}` +
    `&epoch=gte.${cutoff}&order=epoch.asc`;
  try {
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    if (!res.ok) {
      console.error(`History query failed: ${res.status} ${res.statusText}`);
      return [];
    }
    const rows = await res.json();
    return rows.map((r) => ({ epoch: r.epoch, water: r.water, air: r.air, windSpeed: r.wind_speed }));
  } catch (err) {
    console.error(`Network error fetching history: ${err.message}`);
    return [];
  }
}

// Upsert the single forecast row for this location (replace-on-write via the
// location_id primary key). Returns true on success, false on any failure.
async function upsertForecast(payload) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/forecast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        // ON CONFLICT (location_id) DO UPDATE — keep only the newest projection.
        Prefer: "resolution=merge-duplicates",
      },
      body: JSON.stringify({
        location_id: STORAGE_ID,
        generated_at: new Date().toISOString(),
        payload,
      }),
    });
    if (!res.ok) {
      console.error(`Forecast upsert failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Network error upserting forecast: ${err.message}`);
    return false;
  }
}

// Refresh the stored 48h projection. Independent of the water-source path: does
// its own met.no fetch, queries history, builds the projection, upserts. Fully
// fail-soft — any gap just leaves the previous forecast row in place.
async function updateForecast() {
  let json;
  try {
    const res = await fetch(FORECAST_API_URL, { headers: { "User-Agent": MET_USER_AGENT } });
    if (!res.ok) {
      console.error(`Forecast series request failed: ${res.status} ${res.statusText}`);
      return;
    }
    json = await res.json();
  } catch (err) {
    console.error(`Network error fetching forecast series: ${err.message}`);
    return;
  }
  const series = extractForecastSeries(json);
  if (series.length === 0) {
    console.error("No usable met.no forecast entries; skipping projection.");
    return;
  }
  const history = await fetchHistory();
  if (history.length < 2) {
    console.error("Not enough history to project; skipping projection.");
    return;
  }
  const payload = buildProjection(history, series, { horizonH: HORIZON_H });
  if (await upsertForecast(payload)) {
    console.log(`Projection updated: model=${payload.model}, points=${payload.points.length}`);
  }
}
```

- [ ] **Step 3: Call `updateForecast()` from `main()`**

Replace the body of `main()`:

```js
async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    return;
  }
  const row = YR_API_KEY ? await pollOfficial() : await pollUnofficial();
  if (row) {
    const ok = await insertRow(row);
    if (ok) console.log(`Inserted reading: water=${row.water}C at ${row.time}`);
  }
  await updateForecast(); // fail-soft projection refresh; never blocks the insert
}
```

- [ ] **Step 4: Run the existing suite (no new unit tests; guard against regressions)**

Run: `npm test`
Expected: PASS (all existing lib/data tests).

- [ ] **Step 5: Manual smoke against Supabase**

Prereq: the Task 1 DDL has been applied in Supabase.
Run (dev creds, unofficial path is fine — no `YR_API_KEY` needed):
`SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js`
Expected: log line `Projection updated: model=relaxation, points=…` (or `model=persistence` if history is thin). Then confirm the row exists:
`curl -s "<url>/rest/v1/forecast?select=generated_at,payload&location_id=eq.0-10238" -H "apikey: <sb_secret>" -H "Authorization: Bearer <sb_secret>" | head -c 400`
Expected: one row whose `payload.points` is a non-empty array with `epoch/water/lower/upper`.

- [ ] **Step 6: Commit**

```bash
git add scripts/poll.js
git commit -m "feat: poller builds and upserts the 48h projection each poll

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 8: Browser data layer — `forecastQueryUrl` + `mapForecast`

**Files:**
- Modify: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Produces:
  - `forecastQueryUrl(baseUrl, locationId) -> string` — PostgREST URL selecting the single `payload` for the location.
  - `mapForecast(payload) -> { line, lower, band } | null` where `line`/`lower`/`band` are `[ms, value]` pair arrays. `band[i]` is `upper − lower` (the stacked height above `lower`). Returns `null` for a missing/empty payload.

- [ ] **Step 1: Write the failing test**

Add to `test/data.test.js` (import `forecastQueryUrl`, `mapForecast`):

```js
test("forecastQueryUrl targets the forecast endpoint and filters by location", () => {
  const url = new URL(forecastQueryUrl(BASE, "0-10238"));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/forecast`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  assert.equal(url.searchParams.get("select"), "payload");
});

test("mapForecast builds line + stacked band pairs from points", () => {
  const payload = {
    points: [
      { epoch: 1000, water: 15, lower: 15, upper: 15 },
      { epoch: 4600, water: 15.4, lower: 14.9, upper: 15.9 },
    ],
  };
  const m = mapForecast(payload);
  assert.deepEqual(m.line, [[1_000_000, 15], [4_600_000, 15.4]]);
  assert.deepEqual(m.lower, [[1_000_000, 15], [4_600_000, 14.9]]);
  // band = upper - lower, stacked on top of `lower`. Compare ms + tolerance
  // (15.9 - 14.9 is 1.0000000000000009 in float, so avoid exact equality).
  assert.equal(m.band[0][0], 1_000_000);
  assert.equal(m.band[0][1], 0);
  assert.equal(m.band[1][0], 4_600_000);
  assert.ok(Math.abs(m.band[1][1] - 1.0) < 1e-9);
});

test("mapForecast returns null for missing or empty payloads", () => {
  assert.equal(mapForecast(null), null);
  assert.equal(mapForecast({}), null);
  assert.equal(mapForecast({ points: [] }), null);
});
```

> Note: `band` is a plain `upper − lower` subtraction — the test uses a tolerance because `15.9 − 14.9` is `1.0000000000000009` in floating point.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/data.test.js`
Expected: FAIL — `forecastQueryUrl is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `src/data.js`:

```js
// Build a PostgREST query URL for the single stored forecast row at a location.
// PostgREST returns an array; the caller reads [0]?.payload.
export function forecastQueryUrl(baseUrl, locationId) {
  const params = new URLSearchParams();
  params.set("select", "payload");
  params.set("location_id", `eq.${locationId}`);
  return `${baseUrl}/rest/v1/forecast?${params.toString()}`;
}

// Map a stored forecast payload to ECharts series data: a dashed projection
// `line`, plus a confidence band drawn as a transparent `lower` baseline and a
// stacked `band` (= upper − lower) area on top of it. Returns null when there is
// nothing to draw.
export function mapForecast(payload) {
  const points = payload?.points;
  if (!Array.isArray(points) || points.length === 0) return null;
  const line = [];
  const lower = [];
  const band = [];
  for (const p of points) {
    const ms = p.epoch * 1000;
    line.push([ms, p.water]);
    lower.push([ms, p.lower]);
    band.push([ms, p.upper - p.lower]);
  }
  return { line, lower, band };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: forecastQueryUrl + mapForecast for the browser layer

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 9: Chart rendering — dashed projection + band

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: `forecastQueryUrl`, `mapForecast` from `./src/data.js`; the `forecast` table from Task 1; the `{line,lower,band}` shape from Task 8.
- Produces: a `forecast` module variable, `loadForecast()`, and three extra ECharts series (dashed line + two band series) rendered when a projection exists. No new legend entry, no `index.html` change.

- [ ] **Step 1: Import the new helpers**

In `app.js`, add `forecastQueryUrl` and `mapForecast` to the `./src/data.js` import block:

```js
import {
  readingsQueryUrl,
  latestReadingUrl,
  forecastQueryUrl,
  mapForecast,
  mapRow,
  rangeBounds,
  toSeriesPairs,
  waterStats,
  isStale,
  humanizeAge,
  degToArrow,
  waterTrend,
} from "./src/data.js";
```

- [ ] **Step 2: Add the module state and loader**

After `let latest = null;` add:

```js
let forecast = null; // { line, lower, band } | null — the stored 48h projection
```

Add `mapForecast`'s loader alongside `loadLatest` (after the `loadLatest` function):

```js
// Fetch the stored projection for the dashed forecast line + band. On failure,
// leave the existing projection (or its absence) intact — never blank the chart.
async function loadForecast() {
  try {
    const res = await fetch(forecastQueryUrl(SUPABASE_URL, LOCATION_ID), {
      cache: "no-store",
      headers: SUPABASE_HEADERS,
    });
    if (!res.ok) return false;
    const rows = await res.json();
    forecast = mapForecast(rows[0]?.payload);
  } catch {
    return false;
  }
  return true;
}
```

- [ ] **Step 3: Thread `forecast` through render + refresh + init**

Change `buildOption`'s signature and its `render()` call site, and add `loadForecast` to the parallel fetches.

In `render()`, replace the `chart.setOption(...)` line:

```js
  chart.setOption(buildOption(allReadings, forecast, currentRange, nowEpoch()), true);
```

Change the `buildOption` signature line:

```js
function buildOption(readings, forecast, rangeKey, nowEpochSec) {
```

Replace `refresh()`:

```js
// Refresh header (latest reading), chart (selected range), and projection.
async function refresh() {
  await Promise.all([loadLatest(), loadData(), loadForecast()]);
}
```

Replace the `Promise.all` in `init()`:

```js
  const [, ok] = await Promise.all([loadLatest(), loadData(), loadForecast()]);
```

- [ ] **Step 4: Add the tooltip filter and projection unit**

In `buildOption`, add the projection unit to `SERIES_UNIT` (top of `app.js`, module scope):

```js
const SERIES_UNIT = { Vann: "°C", Luft: "°C", Vind: "m/s", "Vann (prognose)": "°C" };
```

In the tooltip `formatter`, drop the invisible band helper series before mapping. Replace:

```js
        const rows = params
          .map((s) => {
```

with:

```js
        const rows = params
          .filter((s) => !s.seriesName.startsWith("_")) // hide band helper series
          .map((s) => {
```

- [ ] **Step 5: Append the projection series**

In `buildOption`, inside the returned option's `series: [ ... ]` array, add the three series after the existing `Vind` series object (still inside the array). Guard with a spread so nothing is added when there's no projection:

```js
      ...(forecast
        ? [
            // Transparent baseline at `lower`; the band area stacks on top of it.
            {
              name: "_prognoseLo",
              type: "line",
              stack: "prognose-band",
              yAxisIndex: 0,
              data: forecast.lower,
              showSymbol: false,
              silent: true,
              lineStyle: { opacity: 0 },
              z: 1,
            },
            // Shaded band = (upper - lower) stacked above `lower`, spanning [lower,upper].
            {
              name: "_prognoseBand",
              type: "line",
              stack: "prognose-band",
              yAxisIndex: 0,
              data: forecast.band,
              showSymbol: false,
              silent: true,
              lineStyle: { opacity: 0 },
              areaStyle: { color: "rgba(14,165,233,0.15)" },
              z: 1,
            },
            // Dashed projection line in the water color, continuing the solid line.
            {
              name: "Vann (prognose)",
              type: "line",
              smooth: true,
              showSymbol: false,
              yAxisIndex: 0,
              data: forecast.line,
              lineStyle: { width: 2, color: "#0ea5e9", type: "dashed" },
              itemStyle: { color: "#0ea5e9" },
              z: 3,
            },
          ]
        : []),
```

- [ ] **Step 6: Verify locally in the browser**

Prereq: Task 7's smoke populated a `forecast` row in the dev Supabase project (or point `src/config.js` at one that has it).
Run: `python3 -m http.server 8000` then open `http://localhost:8000/`.
Expected, verified by eye:
- A **dashed sky-blue line** extends to the right of the last solid water point (48h ahead), starting exactly where the solid line ends (no gap).
- A **shaded band** hugs the dashed line, **zero-width at "now" and widening** toward +48h.
- Hovering the projection shows a `Vann (prognose): X °C` tooltip row and **no** `_prognose…` rows.
- On the 24h/7d ranges the projection is prominent at the right edge; on 30d/all it's a small sliver. Toggling ranges keeps it correct.

- [ ] **Step 7: Commit**

```bash
git add app.js
git commit -m "feat: render dashed 48h projection with a confidence band

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 10: Documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Document the forecast half in `CLAUDE.md`**

In the **Architecture** section, after the "Browser app" bullet, add a paragraph:

```markdown
- **Forecast** (`scripts/poll.js:updateForecast` → `scripts/lib.js`): each poll
  also builds a best-effort 48h water-temperature projection. `lib.js` fits a
  relaxation model `dWater/dt = a·(air−water) + b·wind + c` from ~30 days of
  history (`fitRelaxation`), rolls it forward on the met.no forecast timeseries
  (`extractForecastSeries` → `rollForward`), sizes a confidence band from a
  walk-forward backtest (`backtestError`, inflated by `INFLATE=1.3` for
  forecast-input error), and assembles the payload (`buildProjection`). `poll.js`
  upserts one row into the `forecast` table (replace-on-write, keyed by
  `location_id`). The browser reads it via `forecastQueryUrl`/`mapForecast`
  (`src/data.js`) and draws a dashed line + shaded band. When the fit is
  untrustworthy it falls back to flat persistence (`model: "persistence"`).
```

In the **Config knobs** section, under the secrets bullet, add:

```markdown
- Forecast model tunables (constants in `scripts/lib.js`): `FIT_WINDOW_DAYS`,
  `MIN_GAP_S`/`MAX_GAP_S`, `MIN_PAIRS`, `HORIZON_H`, `INFLATE`,
  `BACKTEST_HORIZONS`/`BACKTEST_STRIDE`, `FALLBACK_ERR`.
```

In the **Append-only data invariant** section, add a closing sentence:

```markdown
The separate `forecast` table is the one exception to append-only: it holds a
single row per location, replaced each poll via `Prefer: resolution=merge-duplicates`
(ON CONFLICT DO UPDATE). It never affects `readings`.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document the 48h forecast half

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Self-Review

**Spec coverage:**
- 48h horizon → `HORIZON_H=48`, enforced in `rollForward`/`buildProjection` (Tasks 4, 6). ✓
- Server-side compute → Task 7 `updateForecast`. ✓
- Relaxation model + OLS in-repo → Task 3. ✓
- Roll forward on met.no forecast → Tasks 2, 4. ✓
- Backtest → band, widening, 1.3× inflation → Tasks 5, 6. ✓
- Persistence fallback + transparent `model` field → Tasks 3, 6. ✓
- `forecast` table, replace-on-write, anon SELECT → Tasks 1, 7. ✓
- Browser dashed line + band, always-on, tooltip clean → Tasks 8, 9. ✓
- Fail-soft everywhere → Tasks 7 (poller), 9 (`loadForecast`). ✓
- TDD, zero deps → all lib/data tasks test-first; no packages added. ✓

**Placeholder scan:** no TBD/TODO; every code step shows complete code. ✓

**Type consistency:** model helpers consume camelCase `{epoch,water,air,windSpeed}`; `poll.js:fetchHistory` maps `wind_speed → windSpeed` (Task 7). `extractForecastSeries` emits `{epoch,air,windSpeed}` matching `rollForward`'s driver. `buildProjection` payload (`points:{epoch,water,lower,upper}`, `model`, `coeffs`, `backtest`) matches the schema comment (Task 1), the upsert body (Task 7), and `mapForecast`'s reader (Task 8). Band series names prefixed `_` are filtered by the tooltip (Task 9, Step 4) and excluded from the legend by omission. ✓
