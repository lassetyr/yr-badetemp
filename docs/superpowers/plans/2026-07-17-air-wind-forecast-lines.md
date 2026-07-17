# Air & Wind Forecast Lines Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw forward dashed Luft (air) and Vind (wind) forecast lines alongside the water projection, under one convention — solid = measured, dashed = forecast.

**Architecture:** Payload-content + rendering. `buildProjection` already has the met.no air/wind forecast in hand, so it persists `air`/`windSpeed`/`windDir` onto each projection point (no schema change; one `wind_dir` column added to the poller's history query for the seed). The browser maps those to `airLine`/`windLine`, reuses the existing per-range `clampForecast` horizon, and draws two more dashed series; observed Vind is restyled to solid.

**Tech Stack:** Node 20+ (`node --test`, zero deps), native ES modules, ECharts (CDN global `echarts`), Supabase PostgREST.

## Global Constraints

- **Zero dependencies**, pure JS only.
- **Pure/I-O split:** model logic in `scripts/lib.js`; browser derivation in `src/data.js` (both I/O-free, unit-tested via `node --test`). DOM/network in `app.js` / `scripts/poll.js`.
- **No schema migration:** the `forecast.payload` is `jsonb`; only its contents grow. The sole poller change is adding `wind_dir` to `fetchHistory`'s `select`.
- **Styling convention:** observed = solid, forecast = dashed. Observed **Vind** becomes a thin **solid** gray line (1.5px, `#94a3b8`). Luft forecast = dashed amber `#f59e0b`; Vind forecast = dashed gray `#94a3b8`. **No band** on air/wind forecasts.
- **Series names (exact):** `"Luft (prognose)"`, `"Vind (prognose)"` (matching existing `"Vann (prognose)"`). Units: Luft `°C`, Vind `m/s`.
- **Point shape:** `{ epoch, water, lower, upper, air, windSpeed, windDir }`.
- **Horizon reuse:** the new lines ride the existing `clampForecast` + `FORECAST_HORIZON_H` (24t → 12h; 7d/30d/all → 48h).
- **Legend coupling:** each forecast line draws only when its observed counterpart is enabled (`legendSelected?.<Name> !== false`); applies to water, air, and wind.
- **Wind bearing** rides `windLine` as a third element `[ms, windSpeed, windDir]`; the forecast Vind tooltip shows the same `degToArrow` arrow as observed Vind.
- **All commits** end with `Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe`.

---

## File Structure

- `scripts/lib.js` — **modify**: `extractForecastSeries` adds `windDir`; `buildProjection` attaches `air`/`windSpeed`/`windDir` to each point.
- `test/lib.test.js` — **modify**: update `extractForecastSeries` test; add a `buildProjection` point-fields test.
- `scripts/poll.js` — **modify**: `fetchHistory` selects/maps `wind_dir` → `windDir`.
- `src/data.js` — **modify**: `mapForecast` emits `airLine`/`windLine`; `clampForecast` trims them.
- `test/data.test.js` — **modify**: add `mapForecast` and `clampForecast` tests for the new arrays.
- `app.js` — **modify**: restyle observed Vind; add a `forecastSeries` helper (legend-coupled) with the two new dashed series; tooltip units + arrow; re-render on legend toggle.

---

## Task 1: `extractForecastSeries` carries wind direction

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Produces: `extractForecastSeries(json) -> Array<{ epoch, air, windSpeed, windDir }>` — `windDir` from `instant.details.wind_from_direction` (null when absent).

- [ ] **Step 1: Update the failing test**

In `test/lib.test.js`, replace the `METNO_SAMPLE` fixture and the `extractForecastSeries` "ascending" test with:

```js
const METNO_SAMPLE = {
  properties: {
    timeseries: [
      { time: "2026-07-17T10:00:00Z", data: { instant: { details: { air_temperature: 21.0, wind_speed: 2.5, wind_from_direction: 180 } } } },
      { time: "2026-07-17T11:00:00Z", data: { instant: { details: { air_temperature: 21.6, wind_speed: 3.1 } } } }, // no direction → windDir null
      { time: "2026-07-17T12:00:00Z", data: { instant: { details: {} } } }, // no air → skipped
    ],
  },
};

test("extractForecastSeries returns ascending {epoch,air,windSpeed,windDir}, skipping entries with no air", () => {
  const series = extractForecastSeries(METNO_SAMPLE);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], {
    epoch: Math.floor(Date.parse("2026-07-17T10:00:00Z") / 1000),
    air: 21.0,
    windSpeed: 2.5,
    windDir: 180,
  });
  assert.equal(series[1].air, 21.6);
  assert.equal(series[1].windDir, null); // absent wind_from_direction → null
  assert.ok(series[0].epoch < series[1].epoch);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `series[0]` deepEqual mismatch (no `windDir` yet).

- [ ] **Step 3: Write the implementation**

In `scripts/lib.js`, in `extractForecastSeries`, change the pushed object:

```js
    out.push({ epoch, air, windSpeed: num(details?.wind_speed), windDir: num(details?.wind_from_direction) });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS (all, including pre-existing).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: extractForecastSeries carries wind_from_direction as windDir

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 2: `buildProjection` attaches air/wind/dir to each point

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `forecastSeries` entries `{ epoch, air, windSpeed, windDir }` (Task 1); `history` readings whose last element may carry `air`/`windSpeed`/`windDir`.
- Produces: `buildProjection(...)` points now each carry `air`, `windSpeed`, `windDir` (null when unavailable). The seed point (`points[0]`) takes them from the last history reading; forecast points take them from the matching forecast entry by epoch.

- [ ] **Step 1: Write the failing test**

Add to `test/lib.test.js` (near the other `buildProjection` tests):

```js
test("buildProjection attaches air/windSpeed/windDir (seed from history, rest from the forecast)", () => {
  const history = synthReadings({ a: 0.05, b: 0.01, c: -0.002, n: 400 });
  const seed = history[history.length - 1];
  seed.windDir = 210; // last observed reading carries a bearing
  const forecastSeries = Array.from({ length: 3 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 18 + i,
    windSpeed: 4 + i,
    windDir: 90 + i,
  }));
  const p = buildProjection(history, forecastSeries);
  // seed point carries the last observed values
  assert.equal(p.points[0].air, seed.air);
  assert.equal(p.points[0].windSpeed, seed.windSpeed);
  assert.equal(p.points[0].windDir, 210);
  // first forecast point carries the forecast entry's values
  assert.equal(p.points[1].air, 18);
  assert.equal(p.points[1].windSpeed, 4);
  assert.equal(p.points[1].windDir, 90);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `p.points[0].air` is `undefined` (points don't carry air/wind yet).

- [ ] **Step 3: Write the implementation**

In `scripts/lib.js`, replace the body of `buildProjection` (from `const seed =` through the `points.push` loop, keeping the surrounding function and return) so it reads:

```js
export function buildProjection(history, forecastSeries, opts = {}) {
  const horizonH = opts.horizonH ?? HORIZON_H;
  const fit = fitRelaxation(history);
  const coeffs = fit.ok ? { a: fit.a, b: fit.b, c: fit.c } : { a: 0, b: 0, c: 0 };
  const seed = history[history.length - 1];
  const rolled = rollForward({ epoch: seed.epoch, water: seed.water }, forecastSeries, coeffs, { horizonH });
  const err = backtestError(history, coeffs, BACKTEST_HORIZONS);
  // The met.no air/wind/dir driving each forecast timestamp, so the browser can
  // draw them as forward lines. Keyed by epoch to match each rolled point.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS (all — the pre-existing `buildProjection` tests still hold; the new fields are additive).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: buildProjection attaches air/windSpeed/windDir to each point

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 3: Poller seeds wind direction from history

**Files:**
- Modify: `scripts/poll.js`

**Interfaces:**
- Produces: `fetchHistory` rows now include `windDir` (from `readings.wind_dir`), so `buildProjection`'s seed point carries the last observed wind direction live.

- [ ] **Step 1: Add `wind_dir` to the history query and mapping**

In `scripts/poll.js`, in `fetchHistory`, change the `select` in the URL:

```js
    `?select=epoch,water,air,wind_speed,wind_dir&location_id=eq.${STORAGE_ID}` +
```

and change the row mapping to include `windDir`:

```js
    return rows.map((r) => ({ epoch: r.epoch, water: r.water, air: r.air, windSpeed: r.wind_speed, windDir: r.wind_dir })).reverse();
```

- [ ] **Step 2: Verify syntax and suite**

Run: `node --check scripts/poll.js`
Expected: no output.

Run: `npm test`
Expected: full suite green (unchanged — this is an I/O-only edit).

- [ ] **Step 3: Commit**

```bash
git add scripts/poll.js
git commit -m "feat: fetchHistory carries wind_dir so the projection seed has a bearing

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 4: `mapForecast` + `clampForecast` expose air/wind lines

**Files:**
- Modify: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Produces:
  - `mapForecast(payload)` also returns `airLine` (`[ms, air]` pairs) and `windLine` (`[ms, windSpeed, windDir]` pairs — the bearing rides as a third element).
  - `clampForecast(...)` also trims `airLine` and `windLine` to the horizon (filtered by `ms`, the first element), tolerating their absence.

- [ ] **Step 1: Write the failing tests**

Add to `test/data.test.js`:

```js
test("mapForecast builds airLine and windLine (bearing as a third element)", () => {
  const payload = {
    points: [
      { epoch: 1000, water: 15, lower: 15, upper: 15, air: 18, windSpeed: 3, windDir: 200 },
      { epoch: 4600, water: 15.4, lower: 14.9, upper: 15.9, air: 18.5, windSpeed: 4, windDir: 210 },
    ],
  };
  const m = mapForecast(payload);
  assert.deepEqual(m.airLine, [[1_000_000, 18], [4_600_000, 18.5]]);
  assert.deepEqual(m.windLine, [[1_000_000, 3, 200], [4_600_000, 4, 210]]);
});

test("clampForecast trims airLine and windLine to the horizon too", () => {
  const fc = {
    line:  [[1_000_000, 20], [87_400_000, 20.1]],
    lower: [[1_000_000, 20], [87_400_000, 19.3]],
    band:  [[1_000_000, 0],  [87_400_000, 1.6]],
    airLine:  [[1_000_000, 18], [87_400_000, 17]],
    windLine: [[1_000_000, 3, 200], [87_400_000, 5, 210]],
  };
  const c = clampForecast(fc, FC_NOW, 12); // cutoff 44_200_000 → drop the 87_400_000 point
  assert.deepEqual(c.airLine, [[1_000_000, 18]]);
  assert.deepEqual(c.windLine, [[1_000_000, 3, 200]]); // third element preserved
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `m.airLine` is `undefined`.

- [ ] **Step 3: Write the implementation**

In `src/data.js`, replace `mapForecast` with:

```js
export function mapForecast(payload) {
  const points = payload?.points;
  if (!Array.isArray(points) || points.length === 0) return null;
  const line = [];
  const lower = [];
  const band = [];
  const airLine = [];
  const windLine = [];
  for (const p of points) {
    const ms = p.epoch * 1000;
    line.push([ms, p.water]);
    lower.push([ms, p.lower]);
    band.push([ms, p.upper - p.lower]);
    airLine.push([ms, p.air ?? null]);
    // Bearing rides as a third element: the line plots windSpeed, the tooltip reads dir.
    windLine.push([ms, p.windSpeed ?? null, p.windDir ?? null]);
  }
  return { line, lower, band, airLine, windLine };
}
```

and replace `clampForecast` with:

```js
export function clampForecast(forecast, nowEpochSec, maxHorizonH) {
  if (!forecast || !forecast.line?.length) return null;
  const cutoffMs = (nowEpochSec + maxHorizonH * 3600) * 1000;
  const within = (arr) => (arr ?? []).filter(([ms]) => ms <= cutoffMs);
  const line = forecast.line.filter(([ms]) => ms <= cutoffMs);
  if (line.length === 0) return null;
  return {
    line,
    lower: within(forecast.lower),
    band: within(forecast.band),
    airLine: within(forecast.airLine),
    windLine: within(forecast.windLine),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS (all — the pre-existing `mapForecast`/`clampForecast` tests still hold; `within(undefined)` → `[]` keeps water-only inputs working).

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: mapForecast/clampForecast expose trimmed airLine and windLine

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Task 5: Render the air/wind forecast lines

**Files:**
- Modify: `app.js`

**Interfaces:**
- Consumes: `fc.airLine`, `fc.windLine` (Task 4); `legendSelected` (existing module state).
- Produces: two new dashed forecast series (`"Luft (prognose)"`, `"Vind (prognose)"`), legend-coupled forecast rendering, solid observed Vind, and the forecast Vind tooltip arrow.

- [ ] **Step 1: Restyle observed Vind to solid**

In `app.js`, in the observed `"Vind"` series, change its `lineStyle` (drop `type: "dashed"`):

```js
        lineStyle: { width: 1.5, color: "#94a3b8" },
```

- [ ] **Step 2: Add units for the new forecast series**

In `app.js`, replace the `SERIES_UNIT` constant:

```js
const SERIES_UNIT = {
  Vann: "°C",
  Luft: "°C",
  Vind: "m/s",
  "Vann (prognose)": "°C",
  "Luft (prognose)": "°C",
  "Vind (prognose)": "m/s",
};
```

- [ ] **Step 3: Add the forecast Vind direction arrow to the tooltip**

In `app.js`, in the tooltip `formatter`, immediately after the existing observed-Vind arrow block:

```js
            if (s.seriesName === "Vind" && raw != null) {
              const r = byMs.get(s.value?.[0]);
              line += ` ${degToArrow(r?.windDir) ?? "-"}`;
            }
```

add:

```js
            if (s.seriesName === "Vind (prognose)" && raw != null) {
              line += ` ${degToArrow(s.value?.[2]) ?? "-"}`; // bearing packed as the 3rd element
            }
```

- [ ] **Step 4: Add the `forecastSeries` helper**

In `app.js`, add this function immediately above `function buildOption(...)`:

```js
// Dashed forecast series for the clamped forecast `fc`, honoring the legend:
// each line is drawn only when its observed counterpart is enabled (undefined
// `selected` → all enabled). The water projection also carries its confidence
// band as two silent helper series (names prefixed `_` are hidden from tooltip).
function forecastSeries(fc, selected) {
  if (!fc) return [];
  const on = (name) => selected?.[name] !== false;
  const out = [];
  if (on("Vann")) {
    out.push(
      {
        name: "_prognoseLo",
        type: "line",
        stack: "prognose-band",
        yAxisIndex: 0,
        data: fc.lower,
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        z: 1,
      },
      {
        name: "_prognoseBand",
        type: "line",
        stack: "prognose-band",
        yAxisIndex: 0,
        data: fc.band,
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(14,165,233,0.15)" },
        z: 1,
      },
      {
        name: "Vann (prognose)",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: fc.line,
        lineStyle: { width: 2, color: "#0ea5e9", type: "dashed" },
        itemStyle: { color: "#0ea5e9" },
        z: 3,
      },
    );
  }
  if (on("Luft")) {
    out.push({
      name: "Luft (prognose)",
      type: "line",
      smooth: true,
      showSymbol: false,
      yAxisIndex: 0,
      data: fc.airLine,
      lineStyle: { width: 2, color: "#f59e0b", type: "dashed" },
      itemStyle: { color: "#f59e0b" },
      z: 3,
    });
  }
  if (on("Vind")) {
    out.push({
      name: "Vind (prognose)",
      type: "line",
      smooth: true,
      showSymbol: false,
      yAxisIndex: 1,
      data: fc.windLine,
      lineStyle: { width: 1.5, color: "#94a3b8", type: "dashed" },
      itemStyle: { color: "#94a3b8" },
      z: 3,
    });
  }
  return out;
}
```

- [ ] **Step 5: Use the helper in `buildOption`**

In `app.js`, in `buildOption`'s `series` array, replace the entire forecast spread — the block that begins with `...(fc` and ends with the matching `: []),` (the three inline `_prognoseLo` / `_prognoseBand` / `Vann (prognose)` series) — with a single line:

```js
      ...forecastSeries(fc, legendSelected),
```

- [ ] **Step 6: Re-render on legend toggle so coupling is immediate**

In `app.js`, in the `chart.on("legendselectchanged", ...)` handler, add a `render()` call after persisting, so toggling an observed series immediately shows/hides its forecast line. The handler becomes:

```js
chart.on("legendselectchanged", (params) => {
  legendSelected = params.selected;
  try {
    localStorage.setItem(LEGEND_KEY, JSON.stringify(params.selected));
  } catch {
    // ignore storage failures (private mode, quota)
  }
  render(); // re-render so the forecast line follows its observed series' toggle
});
```

- [ ] **Step 7: Verify syntax and suite**

Run: `node --check app.js`
Expected: no output (valid syntax).

Run: `npm test`
Expected: full suite green (no app.js unit tests; this confirms nothing else regressed).

- [ ] **Step 8: Browser check (deferred to the human)**

No unit tests cover `app.js`, and this is a visual change needing a browser + a `forecast` row whose payload now carries `air`/`windSpeed`/`windDir` (re-run the poller once after Tasks 1–4 land so the stored row has the new fields). **Deferred to the human:** serve the site (`python3 -m http.server 8000`) and confirm: observed Vind is now solid; dashed **Luft** (amber) and **Vind** (gray) forecast lines extend past now; the forecast Vind tooltip shows a direction arrow; toggling **Luft**/**Vind**/**Vann** in the legend hides that series *and* its forecast line. The implementer should NOT attempt this — note it deferred.

- [ ] **Step 9: Commit**

```bash
git add app.js
git commit -m "feat: draw dashed air/wind forecast lines, legend-coupled; solid observed Vind

Claude-Session: https://claude.ai/code/session_015ZuRZiHkmHd7sr7RCDuQFe"
```

---

## Self-Review

**Spec coverage:**
- Both air + wind forecast lines → Task 5 (Luft/Vind prognose series). ✓
- Convention solid=measured/dashed=forecast; observed Vind → solid → Task 5 Steps 1, 4. ✓
- No band on air/wind → Task 5 (only water group has band series). ✓
- Persist air/windSpeed/windDir on points; seed from last observed → Task 2. ✓
- `windDir` from `wind_from_direction` → Task 1. ✓
- One `wind_dir` poller column for the seed → Task 3. ✓
- `mapForecast` airLine/windLine (bearing 3rd element); `clampForecast` trims them → Task 4. ✓
- Reuse per-range horizon → the new lines flow through the existing `clampForecast(fc, …)` call in `buildOption` (unchanged). ✓
- Legend coupling for all three; immediate on toggle → Task 5 Steps 4–6. ✓
- Forecast Vind direction arrow via `degToArrow(value[2])` → Task 5 Step 3. ✓
- TDD on pure helpers; browser deferred → Tasks 1,2,4 test-first; Task 5 Step 8 deferred. ✓

**Placeholder scan:** none — every code step shows complete code. ✓

**Type consistency:** `extractForecastSeries` emits `{epoch,air,windSpeed,windDir}` (Task 1) → consumed by `buildProjection`'s `weather` map (Task 2). Point shape `{epoch,water,lower,upper,air,windSpeed,windDir}` (Task 2) → read by `mapForecast` (`p.air`/`p.windSpeed`/`p.windDir`, Task 4) → `airLine`/`windLine` consumed by `forecastSeries` (`fc.airLine`/`fc.windLine`, Task 5). `fetchHistory` maps `wind_dir → windDir` (Task 3) matching the seed read `seed.windDir` (Task 2). Series names `"Luft (prognose)"`/`"Vind (prognose)"` consistent across `SERIES_UNIT`, the tooltip, and `forecastSeries`. ✓
