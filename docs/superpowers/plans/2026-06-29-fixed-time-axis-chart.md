# Fixed Time-Axis Chart with Gap Breaks — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the chart render on a true time axis pinned to the selected range (right edge = now), breaking the line across gaps longer than 6 hours and keeping isolated readings visible as dots.

**Architecture:** Two pure helpers added to `src/data.js` (`rangeBounds` for the axis min/max, `toSeriesPairs` for `[ms, value]` series data with null breaks), consumed by `buildOption` in `app.js` which switches the x-axis from `category` to `time`. No data-layer, backend, or poller changes.

**Tech Stack:** Vanilla ES modules, ECharts (CDN global), `node --test` (Node 20+), zero dependencies.

## Global Constraints

- Zero runtime dependencies; tests use only `node:test` + `node:assert/strict`.
- Pure logic (no DOM/network/ECharts) lives in `src/data.js`; ECharts/DOM stays in `app.js`.
- ES module syntax matching existing files.
- The reading shape consumed by the chart (from `mapRow`) is `{ time, epoch, water, air, windSpeed, windGust, windDir }`. `epoch` is in **seconds**.
- Series timestamps are **milliseconds** (`epoch * 1000`).
- Break threshold is a single constant `GAP_BREAK_MS = 6 * 3600 * 1000`, the default arg of `toSeriesPairs`.
- A gap breaks the line only when strictly **greater than** the threshold.
- Right edge of the axis is pinned to `now` for all ranges; left edge is `now − range` for 24h/7d/30d and auto (undefined) for `all`.
- `connectNulls` stays at its ECharts default (`false`) — do not set it.
- All user-facing time stays in `Europe/Oslo` (via the existing `osloParts`).

---

## File Structure

- `src/data.js` (modify) — add `GAP_BREAK_MS`, `rangeBounds`, `toSeriesPairs`. Existing `RANGE_SECONDS`, `readingsQueryUrl`, `latestReadingUrl`, `mapRow` unchanged.
- `test/data.test.js` (modify) — add unit tests for the two new helpers.
- `app.js` (modify) — `buildOption` switches to a time axis, pair-based series, range/now params, and tooltip-row value access; `render` passes the new args.

Tasks 1 and 2 are independent pure helpers (each fully unit-tested and mergeable). Task 3 wires them into the chart and is verified visually.

---

### Task 1: `rangeBounds` helper

**Files:**
- Modify: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Consumes: the existing module-level `RANGE_SECONDS` map (`{ "24h": 86400, "7d": 604800, "30d": 2592000 }`).
- Produces: `rangeBounds(rangeKey, nowEpoch) -> { min: number | undefined, max: number }` in **milliseconds**. `max = nowEpoch * 1000`. For a key present in `RANGE_SECONDS`, `min = (nowEpoch - RANGE_SECONDS[rangeKey]) * 1000`. For `"all"` or any unknown key, `min = undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `test/data.test.js` (extend the existing import line at the top to add the new names — see below — rather than adding a second import):

First, change the top import from:

```javascript
import { readingsQueryUrl, latestReadingUrl, mapRow } from "../src/data.js";
```

to:

```javascript
import {
  readingsQueryUrl,
  latestReadingUrl,
  mapRow,
  rangeBounds,
  toSeriesPairs,
  GAP_BREAK_MS,
} from "../src/data.js";
```

Then append these tests:

```javascript
test("rangeBounds '24h' spans now-24h to now, in milliseconds", () => {
  const now = 1_000_000;
  assert.deepEqual(rangeBounds("24h", now), {
    min: (now - 24 * 3600) * 1000,
    max: now * 1000,
  });
});

test("rangeBounds '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  assert.deepEqual(rangeBounds("7d", now), {
    min: (now - 7 * 24 * 3600) * 1000,
    max: now * 1000,
  });
  assert.deepEqual(rangeBounds("30d", now), {
    min: (now - 30 * 24 * 3600) * 1000,
    max: now * 1000,
  });
});

test("rangeBounds 'all' leaves min undefined, max pinned to now", () => {
  const now = 1_000_000;
  assert.deepEqual(rangeBounds("all", now), { min: undefined, max: now * 1000 });
});

test("rangeBounds unknown range leaves min undefined", () => {
  const now = 1_000_000;
  assert.deepEqual(rangeBounds("nope", now), {
    min: undefined,
    max: now * 1000,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `rangeBounds` (and `toSeriesPairs`/`GAP_BREAK_MS`) are not exported (import error / undefined).

- [ ] **Step 3: Implement `rangeBounds`**

In `src/data.js`, add after the `RANGE_SECONDS` definition:

```javascript
// Axis bounds in milliseconds for the selected range. The right edge is always
// pinned to now so a stale feed shows an empty gap up to the current time. For
// "all" (or an unknown key) the left edge is left to ECharts (undefined).
export function rangeBounds(rangeKey, nowEpoch) {
  const max = nowEpoch * 1000;
  if (rangeKey in RANGE_SECONDS) {
    return { min: (nowEpoch - RANGE_SECONDS[rangeKey]) * 1000, max };
  }
  return { min: undefined, max };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: the four `rangeBounds` tests PASS. (`toSeriesPairs` tests still fail — added in Task 2.)

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add rangeBounds helper for time-axis bounds"
```

---

### Task 2: `toSeriesPairs` helper + `GAP_BREAK_MS`

**Files:**
- Modify: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Consumes: an oldest-first array of readings (`{ epoch, water, air, windSpeed, ... }`), a `key` string naming the value field, and an optional `gapBreakMs`.
- Produces:
  - `GAP_BREAK_MS = 6 * 3600 * 1000` (exported constant).
  - `toSeriesPairs(readings, key, gapBreakMs = GAP_BREAK_MS) -> Array<[number, number|null]>`. Emits `[epoch*1000, reading[key]]` for each reading. Between two consecutive readings whose millisecond timestamps differ by **more than** `gapBreakMs`, inserts a single break item `[midpointMs, null]` (midpoint = `Math.floor((prevMs + curMs) / 2)`). A reading whose `key` value is `null`/`undefined` produces `[ms, null]`.

- [ ] **Step 1: Write the failing tests**

Append to `test/data.test.js` (the import was already extended in Task 1; if implementing Task 2 alone, ensure `toSeriesPairs` and `GAP_BREAK_MS` are in the import line):

```javascript
test("GAP_BREAK_MS is six hours in milliseconds", () => {
  assert.equal(GAP_BREAK_MS, 6 * 3600 * 1000);
});

test("toSeriesPairs maps readings to [ms, value] pairs with no breaks within threshold", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 1200, water: 11 }, // +20 min
    { epoch: 2400, water: 12 }, // +20 min
  ];
  assert.deepEqual(toSeriesPairs(readings, "water"), [
    [0, 10],
    [1_200_000, 11],
    [2_400_000, 12],
  ]);
});

test("toSeriesPairs inserts one [midpoint, null] break for a gap over the threshold", () => {
  // 6h = 21600s. A 21601s gap exceeds the threshold; a 21600s gap does not.
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 21_601, water: 12 },
  ];
  assert.deepEqual(toSeriesPairs(readings, "water"), [
    [0, 10],
    [Math.floor((0 + 21_601_000) / 2), null],
    [21_601_000, 12],
  ]);
});

test("toSeriesPairs does not break on a gap exactly equal to the threshold", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 21_600, water: 12 }, // exactly 6h
  ];
  assert.deepEqual(toSeriesPairs(readings, "water"), [
    [0, 10],
    [21_600_000, 12],
  ]);
});

test("toSeriesPairs keeps an isolated reading (break before and after) as a pair", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 30_000, water: 11 }, // big gap before and after (>6h each)
    { epoch: 60_000, water: 12 },
  ];
  const out = toSeriesPairs(readings, "water");
  // The middle reading survives as a real pair amid the null breaks.
  assert.ok(out.some((item) => item[0] === 30_000_000 && item[1] === 11));
  // Two breaks inserted (one before, one after the middle reading).
  assert.equal(out.filter((item) => item[1] === null).length, 2);
});

test("toSeriesPairs passes through a null field value as [ms, null]", () => {
  const readings = [
    { epoch: 0, air: 20 },
    { epoch: 1200, air: null }, // water-only row: no air
  ];
  assert.deepEqual(toSeriesPairs(readings, "air"), [
    [0, 20],
    [1_200_000, null],
  ]);
});

test("toSeriesPairs respects a custom gapBreakMs", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 120, water: 11 }, // +2 min
  ];
  // 1-minute threshold → 2-min gap breaks.
  const out = toSeriesPairs(readings, "water", 60 * 1000);
  assert.equal(out.filter((item) => item[1] === null).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `toSeriesPairs` / `GAP_BREAK_MS` not exported.

- [ ] **Step 3: Implement `GAP_BREAK_MS` and `toSeriesPairs`**

In `src/data.js`, add:

```javascript
// A gap larger than this between consecutive readings breaks the chart line, so
// a stale or interrupted feed reads as missing data rather than a straight line.
export const GAP_BREAK_MS = 6 * 3600 * 1000;

// Build ECharts time-axis data ([ms, value] pairs) for one series. Inserts a
// [midpoint, null] break between consecutive readings more than gapBreakMs
// apart; ECharts splits the line at the null (connectNulls stays false) and
// still draws a symbol for an isolated point left between two breaks. A null
// field value (e.g. air on a water-only row) passes through as [ms, null].
export function toSeriesPairs(readings, key, gapBreakMs = GAP_BREAK_MS) {
  const out = [];
  for (let i = 0; i < readings.length; i++) {
    const ms = readings[i].epoch * 1000;
    if (i > 0) {
      const prevMs = readings[i - 1].epoch * 1000;
      if (ms - prevMs > gapBreakMs) {
        out.push([Math.floor((prevMs + ms) / 2), null]);
      }
    }
    out.push([ms, readings[i][key] ?? null]);
  }
  return out;
}
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all new `toSeriesPairs`/`GAP_BREAK_MS` tests, the Task 1 `rangeBounds` tests, the pre-existing `data.test.js` tests, and the `lib.test.js` tests.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add toSeriesPairs helper for time-axis series with gap breaks"
```

---

### Task 3: Switch `buildOption` to a time axis

**Files:**
- Modify: `app.js` (import line ~1; `buildOption` ~51-146; `render` ~148-157)

**Interfaces:**
- Consumes: `rangeBounds`, `toSeriesPairs` from `./src/data.js`; the existing `nowEpoch()` and `currentRange` in `app.js`.
- Produces: `buildOption(readings, rangeKey, nowEpoch)` returning the ECharts option with a `type: "time"` x-axis.

> No unit test: `buildOption` builds an ECharts option object and references the `echarts` global (the area gradient), so it cannot run under `node --test`. The pure logic it now depends on is fully covered by Tasks 1–2. This task is verified by the suite still passing plus a visual check.

- [ ] **Step 1: Update the import line**

Change `app.js` line 1 from:

```javascript
import { readingsQueryUrl, latestReadingUrl, mapRow } from "./src/data.js";
```

to:

```javascript
import {
  readingsQueryUrl,
  latestReadingUrl,
  mapRow,
  rangeBounds,
  toSeriesPairs,
} from "./src/data.js";
```

- [ ] **Step 2: Rewrite `buildOption` for the time axis**

Replace the entire `buildOption` function (currently `app.js:51-146`) with:

```javascript
function buildOption(readings, rangeKey, nowEpoch) {
  const bounds = rangeBounds(rangeKey, nowEpoch);
  return {
    grid: { left: 50, right: 50, top: 30, bottom: 40 },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        const p = osloParts(params[0].axisValue, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const header = `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`;
        const rows = params
          .map((s) => `${s.marker}${s.seriesName}: <b>${s.value?.[1] ?? "–"}</b>`)
          .join("<br>");
        return `${header}<br>${rows}`;
      },
    },
    legend: {
      data: ["Vann", "Luft", "Vind"],
      top: 0,
      // Centered so it clears both axis-name corners ("°C" left, "m/s" right).
      left: "center",
      selected: legendSelected,
      // Default legend text (#333) is invisible on the dark panel; use the
      // theme's light text for active items and muted gray for toggled-off ones.
      textStyle: { color: "#e2e8f0", fontSize: 13 },
      inactiveColor: "#64748b",
    },
    xAxis: {
      type: "time",
      // Right edge pinned to now; left edge spans the selected range (undefined
      // for "all", letting ECharts fit the earliest reading).
      min: bounds.min,
      max: bounds.max,
      axisLabel: {
        formatter: (value) => {
          const p = osloParts(value, {
            day: "numeric",
            month: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
        },
      },
    },
    yAxis: [
      { type: "value", name: "°C", scale: true, position: "left" },
      {
        type: "value",
        name: "m/s",
        scale: true,
        position: "right",
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "Vann",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: toSeriesPairs(readings, "water"),
        lineStyle: { width: 3, color: "#0ea5e9" },
        itemStyle: { color: "#0ea5e9" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(14,165,233,0.35)" },
            { offset: 1, color: "rgba(14,165,233,0.02)" },
          ]),
        },
      },
      {
        name: "Luft",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: toSeriesPairs(readings, "air"),
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
      },
      {
        name: "Vind",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        data: toSeriesPairs(readings, "windSpeed"),
        lineStyle: { width: 1.5, color: "#94a3b8", type: "dashed" },
        itemStyle: { color: "#94a3b8" },
      },
    ],
  };
}
```

- [ ] **Step 3: Update `render` to pass range + now**

In `render` (`app.js:148-157`), change the `chart.setOption` call from:

```javascript
  chart.setOption(buildOption(allReadings), true);
```

to:

```javascript
  chart.setOption(buildOption(allReadings, currentRange, nowEpoch()), true);
```

- [ ] **Step 4: Run the test suite**

Run: `npm test`
Expected: PASS (unchanged — `app.js` has no unit tests; this confirms the data-layer helpers and imports are intact).

- [ ] **Step 5: Visual verification**

Run: `python3 -m http.server 8000`, open `http://localhost:8000/`, and confirm:
1. The chart renders with time-spaced points (x-axis labels are real clock times, not evenly indexed).
2. Switching ranges (24t / 7d / 30d) re-scales the axis; the **right edge sits at the current time** — if the latest reading is older than now, there is empty space on the right.
3. Tooltip header shows the correct Oslo date/time and each series shows its numeric value (or `–`), not `[object Object]` or a pair.
4. If the data contains a gap longer than 6h, the line is broken there; an isolated reading shows as a dot.
   (If no such gap exists in live data, temporarily lower the threshold by passing a small `gapBreakMs` in one `toSeriesPairs` call to confirm the break renders, then revert.)

Stop the server (Ctrl-C).

- [ ] **Step 6: Commit**

```bash
git add app.js
git commit -m "feat: render chart on a fixed time axis with gap breaks"
```

---

## Self-Review

**Spec coverage:**
- Category → time axis → Task 3 (`xAxis.type: "time"`). ✅
- Right edge pinned to now, left = now−range, `all` auto → Task 1 (`rangeBounds`) + Task 3 (min/max). ✅
- `[ms, value]` pair series → Task 2 (`toSeriesPairs`) + Task 3 (series data). ✅
- Break line on gaps > 6h (strictly greater) → Task 2 (midpoint null insertion; threshold test). ✅
- Isolated reading stays visible as a dot → Task 2 (pair survives between breaks) + Task 3 (`showSymbol: false` relies on ECharts isolated-point symbol; visual check Step 5.4). ✅
- Null field value passthrough → Task 2 (`?? null`; passthrough test). ✅
- `GAP_BREAK_MS = 6h` single tunable → Task 2. ✅
- Tooltip/axis-label formatters handle ms timestamps; tooltip rows use `s.value[1]` → Task 3. ✅
- `connectNulls` left at default → Task 3 (not set anywhere). ✅
- Oslo time formatting preserved → Task 3 (`osloParts` unchanged, accepts ms). ✅
- Unit tests for both helpers → Tasks 1–2. ✅
- No backend/data-layer/range-set changes → confirmed (only additive helpers + buildOption edits). ✅

**Placeholder scan:** No TBD/TODO; every code step has complete code and exact commands. ✅

**Type consistency:** `rangeBounds(rangeKey, nowEpoch) -> {min,max}` (ms) used in Task 3 as `bounds.min`/`bounds.max`. `toSeriesPairs(readings, key)` returns `[ms, value|null]`; Task 3 reads `s.value?.[1]` in the tooltip — consistent. Series keys `"water"`/`"air"`/`"windSpeed"` match the `mapRow` camelCase shape. ✅
