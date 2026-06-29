# Glanceability Enrichments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the water-temp page readable at a glance — stale badge, 24h trend arrow, an 18° comfort line, dataZoom, gust/direction in the tooltip, and a per-range stats row — without touching the backend or data layer.

**Architecture:** All computation goes into pure, unit-tested helpers in [src/data.js](src/data.js) (the existing I/O-free seam); all DOM/ECharts wiring stays in [app.js](app.js). The wind gust/direction fields are already fetched and mapped (`windGust`, `windDir`) — only the UI is new. Helper tasks are strict TDD (`node --test`); UI tasks are wired against those helpers and verified visually on the served page.

**Tech Stack:** Vanilla ES modules, ECharts 5 (CDN), `node:test` (Node 20+, zero deps), Intl APIs for Norwegian formatting. No build step.

## Global Constraints

- **Zero dependencies.** No new npm packages; tests run on `node --test` alone.
- **Pure helpers only in `src/data.js`** — no DOM, no network, no `Date.now()`. Thresholds are passed in as arguments.
- **All user-facing time in `Europe/Oslo`** via the existing `osloParts` helper, regardless of device timezone.
- **All UI copy in Norwegian.** Numbers use `Intl.NumberFormat("nb-NO")` (comma decimal separator).
- **Append-only / read-only frontend** — no changes to the Supabase query, schema, poller, or ranges.
- **Thresholds are named constants in `app.js`** (UI config), copied verbatim:
  `STALE_THRESHOLD_SEC = 2 * 3600`, `COMFORT_TEMP = 18`,
  `TREND_WINDOW_SEC = 24 * 3600`, `TREND_TOLERANCE_SEC = 6 * 3600`.
- **Reading shape** (oldest-first in `allReadings`, from `mapRow`):
  `{ time, epoch, water, air, windSpeed, windGust, windDir }`. `epoch` is seconds.
  Any numeric field may be `null`.

---

## Task 1: `waterStats` helper

**Files:**
- Modify: `src/data.js` (add export)
- Test: `test/data.test.js` (add cases + import)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `waterStats(readings) -> { min: number, max: number, avg: number } | null` — over the non-null `water` values; `null` when there are none. `avg` is the unrounded arithmetic mean.

- [ ] **Step 1: Write the failing tests**

Add to `test/data.test.js` (and add `waterStats` to the import block from `../src/data.js`):

```js
test("waterStats returns min/max/avg over non-null water values", () => {
  const s = waterStats([
    { water: 14 }, { water: 18 }, { water: 16 },
  ]);
  assert.equal(s.min, 14);
  assert.equal(s.max, 18);
  assert.equal(s.avg, 16);
});

test("waterStats ignores null water values", () => {
  const s = waterStats([{ water: 15 }, { water: null }, { water: 17 }]);
  assert.equal(s.min, 15);
  assert.equal(s.max, 17);
  assert.equal(s.avg, 16);
});

test("waterStats returns null when no usable values", () => {
  assert.equal(waterStats([]), null);
  assert.equal(waterStats([{ water: null }, { water: null }]), null);
});

test("waterStats with a single reading gives min=max=avg", () => {
  const s = waterStats([{ water: 16.5 }]);
  assert.deepEqual(s, { min: 16.5, max: 16.5, avg: 16.5 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `waterStats is not a function` / `not exported`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/data.js`:

```js
// Min/max/mean over the non-null water values in readings, or null when there
// are none. avg is left unrounded; callers format for display.
export function waterStats(readings) {
  const values = readings.map((r) => r.water).filter((v) => v != null);
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS (all `waterStats` cases).

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add waterStats helper for range min/max/avg"
```

---

## Task 2: `isStale` helper

**Files:**
- Modify: `src/data.js` (add export)
- Test: `test/data.test.js` (add cases + import)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `isStale(latestEpoch, nowEpoch, thresholdSec) -> boolean` — `true` when `nowEpoch - latestEpoch > thresholdSec` (strict). `latestEpoch`/`nowEpoch` in seconds. Null/undefined `latestEpoch` → `false`.

- [ ] **Step 1: Write the failing tests**

Add to `test/data.test.js` (add `isStale` to the import block):

```js
test("isStale is false just under the threshold", () => {
  // 1h 59m old, threshold 2h
  assert.equal(isStale(1000, 1000 + 7140, 7200), false);
});

test("isStale is true past the threshold", () => {
  // 2h 1m old, threshold 2h
  assert.equal(isStale(1000, 1000 + 7260, 7200), true);
});

test("isStale is false exactly at the threshold (strict >)", () => {
  assert.equal(isStale(1000, 1000 + 7200, 7200), false);
});

test("isStale is false when latestEpoch is missing", () => {
  assert.equal(isStale(null, 99999, 7200), false);
  assert.equal(isStale(undefined, 99999, 7200), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `isStale is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/data.js`:

```js
// True when the latest reading is older than thresholdSec. Epochs in seconds.
// A missing latestEpoch is treated as not-stale (nothing to flag).
export function isStale(latestEpoch, nowEpoch, thresholdSec) {
  if (latestEpoch == null) return false;
  return nowEpoch - latestEpoch > thresholdSec;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add isStale helper for the staleness badge"
```

---

## Task 3: `humanizeAge` helper

**Files:**
- Modify: `src/data.js` (add export)
- Test: `test/data.test.js` (add cases + import)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `humanizeAge(seconds) -> string` — `"<n> min"` (<60 min), `"<n> t"` (<24 h), else `"<n> d"`. Floored integers. Negative/null → `"0 min"`.

- [ ] **Step 1: Write the failing tests**

Add to `test/data.test.js` (add `humanizeAge` to the import block):

```js
test("humanizeAge renders minutes under an hour", () => {
  assert.equal(humanizeAge(0), "0 min");
  assert.equal(humanizeAge(59 * 60), "59 min");
});

test("humanizeAge rolls into hours at 60 minutes", () => {
  assert.equal(humanizeAge(60 * 60), "1 t");
  assert.equal(humanizeAge(23 * 3600), "23 t");
});

test("humanizeAge rolls into days at 24 hours", () => {
  assert.equal(humanizeAge(24 * 3600), "1 d");
  assert.equal(humanizeAge(3 * 86400), "3 d");
});

test("humanizeAge guards negative/null input", () => {
  assert.equal(humanizeAge(-10), "0 min");
  assert.equal(humanizeAge(null), "0 min");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `humanizeAge is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/data.js`:

```js
// Short Norwegian age string for a duration in seconds: "12 min", "3 t", "2 d".
// Floors to the largest whole unit; negative/null collapses to "0 min".
export function humanizeAge(seconds) {
  if (seconds == null || seconds < 0) return "0 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours} t`;
  return `${Math.floor(seconds / 86400)} d`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add humanizeAge helper for reading age"
```

---

## Task 4: `degToCompass` helper

**Files:**
- Modify: `src/data.js` (add export)
- Test: `test/data.test.js` (add cases + import)

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `degToCompass(deg) -> "N"|"NØ"|"Ø"|"SØ"|"S"|"SV"|"V"|"NV" | null` — 8-point compass, nearest sector (45° wide). `null`/non-finite → `null`. Wraps 360 → "N".

- [ ] **Step 1: Write the failing tests**

Add to `test/data.test.js` (add `degToCompass` to the import block):

```js
test("degToCompass maps each cardinal/intercardinal sector", () => {
  assert.equal(degToCompass(0), "N");
  assert.equal(degToCompass(45), "NØ");
  assert.equal(degToCompass(90), "Ø");
  assert.equal(degToCompass(135), "SØ");
  assert.equal(degToCompass(180), "S");
  assert.equal(degToCompass(225), "SV");
  assert.equal(degToCompass(270), "V");
  assert.equal(degToCompass(315), "NV");
});

test("degToCompass wraps around north", () => {
  assert.equal(degToCompass(360), "N");
  assert.equal(degToCompass(359), "N");
  assert.equal(degToCompass(338), "N"); // 337.5 boundary rounds up to N
});

test("degToCompass rounds to the nearest sector", () => {
  assert.equal(degToCompass(22.5), "NØ"); // boundary rounds up
  assert.equal(degToCompass(60), "NØ");   // closer to 45 than 90
  assert.equal(degToCompass(78), "Ø");    // closer to 90 than 45
});

test("degToCompass returns null for missing/invalid input", () => {
  assert.equal(degToCompass(null), null);
  assert.equal(degToCompass(undefined), null);
  assert.equal(degToCompass(NaN), null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `degToCompass is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/data.js`:

```js
// 8-point Norwegian compass abbreviation for a bearing in degrees, or null when
// the bearing is missing/non-finite. Rounds to the nearest 45° sector.
const COMPASS_8 = ["N", "NØ", "Ø", "SØ", "S", "SV", "V", "NV"];
export function degToCompass(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  const normalized = ((deg % 360) + 360) % 360;
  return COMPASS_8[Math.round(normalized / 45) % 8];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add degToCompass helper for wind direction"
```

---

## Task 5: `waterTrend` helper

**Files:**
- Modify: `src/data.js` (add export)
- Test: `test/data.test.js` (add cases + import)

**Interfaces:**
- Consumes: nothing (pure). `readings` is oldest-first.
- Produces: `waterTrend(readings, windowSec, toleranceSec) -> { delta: number, direction: "up"|"down"|"flat" } | null`. Compares the newest non-null-water reading to the non-null-water reading whose `epoch` is nearest `(newest.epoch - windowSec)`, but only if that candidate is within `toleranceSec` of the target. `delta = newest.water - past.water`. `direction` is `"flat"` when `|delta| < 0.05` (rounds to 0,0 at one decimal). `null` when fewer than two usable readings or no candidate within tolerance.

- [ ] **Step 1: Write the failing tests**

Add to `test/data.test.js` (add `waterTrend` to the import block):

```js
const HOUR = 3600;
const DAY = 24 * HOUR;

test("waterTrend reports a warming delta vs ~24h ago", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 15.0 },        // ~24h before newest
      { epoch: 1000 + DAY, water: 15.4 },  // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 0.4) < 1e-9);
});

test("waterTrend reports a cooling delta", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 17.0 },
      { epoch: 1000 + DAY, water: 16.0 },
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "down");
  assert.ok(Math.abs(t.delta + 1.0) < 1e-9);
});

test("waterTrend is flat when the delta rounds to zero", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 16.02 },
      { epoch: 1000 + DAY, water: 16.0 },
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "flat");
});

test("waterTrend returns null when no point is near the 24h-ago target", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 15.0 },          // 12h before newest, > 6h tolerance off the 24h target
      { epoch: 1000 + 12 * HOUR, water: 16.0 }, // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t, null);
});

test("waterTrend returns null with fewer than two usable readings", () => {
  assert.equal(waterTrend([{ epoch: 1000, water: 15 }], DAY, 6 * HOUR), null);
  assert.equal(
    waterTrend([{ epoch: 1000, water: null }, { epoch: 1000 + DAY, water: 16 }], DAY, 6 * HOUR),
    null,
  );
});

test("waterTrend skips null-water candidates and picks the nearest usable one", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 14.0 },           // exactly 24h ago, usable
      { epoch: 1000 + HOUR, water: null },    // closer to target but unusable
      { epoch: 1000 + DAY, water: 15.0 },     // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 1.0) < 1e-9);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `waterTrend is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `src/data.js`:

```js
// Trend of the newest water reading vs the reading nearest windowSec earlier.
// Only readings with a non-null water value count. Returns null unless a
// candidate exists within toleranceSec of the target time (so it won't compare
// against a wildly-off point). direction is "flat" when the delta rounds to 0,0.
export function waterTrend(readings, windowSec, toleranceSec) {
  const usable = readings.filter((r) => r.water != null);
  if (usable.length < 2) return null;
  const newest = usable[usable.length - 1];
  const targetEpoch = newest.epoch - windowSec;
  let best = null;
  let bestDiff = Infinity;
  for (const r of usable) {
    if (r === newest) continue;
    const diff = Math.abs(r.epoch - targetEpoch);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  if (best == null || bestDiff > toleranceSec) return null;
  const delta = newest.water - best.water;
  const direction = Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
  return { delta, direction };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS (full file green).

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add waterTrend helper for the 24h trend arrow"
```

---

## Task 6: Header — reading age + stale badge

**Files:**
- Modify: `app.js` (imports, thresholds, `updateHeader`)
- Modify: `styles.css` (`.as-of.stale`)
- Test: visual (served page)

**Interfaces:**
- Consumes: `humanizeAge`, `isStale` (Tasks 2–3); `nowEpoch()` and `latest` (existing).
- Produces: nothing for later tasks (UI only). Introduces the thresholds constants block that Tasks 7 and 9 also use.

- [ ] **Step 1: Add imports + thresholds in `app.js`**

Extend the `src/data.js` import (currently `readingsQueryUrl, latestReadingUrl, mapRow, rangeBounds, toSeriesPairs`) to also import the new helpers:

```js
import {
  readingsQueryUrl,
  latestReadingUrl,
  mapRow,
  rangeBounds,
  toSeriesPairs,
  waterStats,
  isStale,
  humanizeAge,
  degToCompass,
  waterTrend,
} from "./src/data.js";
```

Add the thresholds constants just below `const RANGES = [...]` (line 13):

```js
// UI thresholds (policy lives here; src/data.js stays free of it).
const STALE_THRESHOLD_SEC = 2 * 3600; // header "utdatert" badge
const COMFORT_TEMP = 18; // comfortable-swim reference line (°C)
const TREND_WINDOW_SEC = 24 * 3600; // trend compares vs ~24h ago
const TREND_TOLERANCE_SEC = 6 * 3600; // max slack on the 24h-ago point
```

- [ ] **Step 2: Update `updateHeader` to append age + toggle stale**

Replace the body of `updateHeader` (lines 169–181) with:

```js
function updateHeader() {
  if (!latest) return;
  document.getElementById("current-temp").textContent = `${latest.water}°C`;
  const p = osloParts(latest.time, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const asOf = document.getElementById("current-asof");
  const now = nowEpoch();
  const age = humanizeAge(now - latest.epoch);
  const stale = isStale(latest.epoch, now, STALE_THRESHOLD_SEC);
  asOf.textContent =
    `oppdatert ${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute} (${age} siden)` +
    (stale ? " ⚠ utdatert" : "");
  asOf.classList.toggle("stale", stale);
}
```

- [ ] **Step 3: Add stale styling in `styles.css`**

Append:

```css
.current .as-of.stale { color: #f59e0b; font-weight: 600; }
```

- [ ] **Step 4: Verify visually**

Run: `python3 -m http.server 8000` and open http://localhost:8000/
Expected: the "oppdatert …" line ends with `(<age> siden)`. With a current feed it is muted gray and has no warning; if the latest reading is >2h old it turns amber and shows `⚠ utdatert`. (To force the stale path locally without waiting, temporarily set `STALE_THRESHOLD_SEC = 0` in the console-loaded build, confirm the amber badge, then revert.)

- [ ] **Step 5: Commit**

```bash
git add app.js styles.css
git commit -m "feat: show reading age and stale badge in the header"
```

---

## Task 7: Header — 24h trend arrow

**Files:**
- Modify: `index.html` (`#current-trend` span)
- Modify: `app.js` (`updateTrend`, call sites, number formatter)
- Modify: `styles.css` (`.trend` colors)
- Test: visual (served page)

**Interfaces:**
- Consumes: `waterTrend` (Task 5); `allReadings`, `TREND_WINDOW_SEC`, `TREND_TOLERANCE_SEC` (Task 6).
- Produces: `updateTrend()` — recomputes and renders the arrow from `allReadings`; called by `render()` (Task 8 also relies on `render` calling it) and after `loadData`.

- [ ] **Step 1: Add the trend element in `index.html`**

In the `.current` div (lines 16–19), insert the trend span between the temp and the as-of:

```html
      <div class="current">
        <span class="temp" id="current-temp">–</span>
        <span class="trend" id="current-trend" hidden></span>
        <span class="as-of" id="current-asof"></span>
      </div>
```

- [ ] **Step 2: Add a signed Norwegian formatter + `updateTrend` in `app.js`**

Add near the top (after the thresholds block) a shared signed 1-decimal formatter:

```js
// "+0,4" / "-1,0" — Norwegian comma, explicit sign, one decimal.
const signedTemp = new Intl.NumberFormat("nb-NO", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "always",
});
```

Add the `updateTrend` function (place it next to `updateHeader`):

```js
function updateTrend() {
  const el = document.getElementById("current-trend");
  const trend = waterTrend(allReadings, TREND_WINDOW_SEC, TREND_TOLERANCE_SEC);
  if (!trend) {
    el.hidden = true;
    return;
  }
  const arrow =
    trend.direction === "up" ? "▲" : trend.direction === "down" ? "▼" : "▬";
  el.textContent = `${arrow} ${signedTemp.format(trend.delta)}°`;
  el.classList.toggle("up", trend.direction === "up");
  el.classList.toggle("down", trend.direction === "down");
  el.classList.toggle("flat", trend.direction === "flat");
  el.hidden = false;
}
```

- [ ] **Step 3: Call `updateTrend` from `render`**

In `render` (lines 158–167), after the `chart.setOption(...)` line, add `updateTrend();`:

```js
function render() {
  const empty = document.getElementById("empty");
  if (allReadings.length === 0) {
    empty.hidden = false;
    chart.clear();
    updateTrend();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(allReadings, currentRange, nowEpoch()), true);
  updateTrend();
}
```

(`updateTrend` runs in both branches so an emptied range hides the arrow. `waterTrend([])` returns `null`, so the empty-branch call just hides it.)

- [ ] **Step 4: Add trend colors in `styles.css`**

Append:

```css
.current .trend { display: block; font-size: 1rem; font-weight: 600; }
.current .trend.up { color: #22c55e; }
.current .trend.down { color: #ef4444; }
.current .trend.flat { color: var(--muted); }
```

- [ ] **Step 5: Verify visually**

Run: `python3 -m http.server 8000` → http://localhost:8000/
Expected: on `30d`/`all` (which contain a point ~24h ago) a green ▲ or red ▼ with a signed delta like `▲ +0,4°` appears under the temperature; switching to a range too short to contain a 24h-ago point hides the arrow.

- [ ] **Step 6: Commit**

```bash
git add index.html app.js styles.css
git commit -m "feat: show 24h water-temperature trend arrow"
```

---

## Task 8: Range stats row

**Files:**
- Modify: `index.html` (`#stats` element)
- Modify: `app.js` (`updateStats`, call from `render`, formatter)
- Modify: `styles.css` (`.stats`)
- Test: visual (served page)

**Interfaces:**
- Consumes: `waterStats` (Task 1); `allReadings` (existing).
- Produces: `updateStats()` — renders the muted min/maks/snitt row per range; called by `render()`.

- [ ] **Step 1: Add the stats element in `index.html`**

In `<main>` (lines 29–34), after the `#empty` paragraph:

```html
    <main>
      <div id="chart" class="chart"></div>
      <p class="empty" id="empty" hidden>
        Ingen målinger registrert ennå. Kom tilbake etter den første målingen.
      </p>
      <p class="stats" id="stats" hidden></p>
    </main>
```

- [ ] **Step 2: Add a plain 1-decimal formatter + `updateStats` in `app.js`**

Add the unsigned formatter near `signedTemp`:

```js
// "16,1" — Norwegian comma, one decimal, no sign.
const plainTemp = new Intl.NumberFormat("nb-NO", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
```

Add `updateStats`:

```js
function updateStats() {
  const el = document.getElementById("stats");
  const s = waterStats(allReadings);
  if (!s) {
    el.hidden = true;
    return;
  }
  el.textContent =
    `min ${plainTemp.format(s.min)}° · ` +
    `maks ${plainTemp.format(s.max)}° · ` +
    `snitt ${plainTemp.format(s.avg)}°`;
  el.hidden = false;
}
```

- [ ] **Step 3: Call `updateStats` from `render`**

Update `render` so both branches refresh the stats (replace the additions from Task 7):

```js
function render() {
  const empty = document.getElementById("empty");
  if (allReadings.length === 0) {
    empty.hidden = false;
    chart.clear();
    updateTrend();
    updateStats();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(allReadings, currentRange, nowEpoch()), true);
  updateTrend();
  updateStats();
}
```

- [ ] **Step 4: Add stats styling in `styles.css`**

Append:

```css
.stats {
  color: var(--muted);
  text-align: center;
  font-size: 0.85rem;
  margin: 8px 0 0;
}
```

- [ ] **Step 5: Verify visually**

Run: `python3 -m http.server 8000` → http://localhost:8000/
Expected: a muted row under the chart reads `min 14,2° · maks 17,8° · snitt 16,1°` (Norwegian commas). Switching ranges recomputes the numbers; a range with no readings hides the row.

- [ ] **Step 6: Commit**

```bash
git add index.html app.js styles.css
git commit -m "feat: add per-range water stats row under the chart"
```

---

## Task 9: Chart — dataZoom, comfort line, reduced motion, `nowEpoch` rename

**Files:**
- Modify: `app.js` (`buildOption`)
- Test: visual (served page)

**Interfaces:**
- Consumes: `COMFORT_TEMP` (Task 6); `rangeBounds`, `toSeriesPairs` (existing).
- Produces: an updated `buildOption(readings, rangeKey, nowEpochSec)` — same return contract, with the parameter renamed from `nowEpoch` to `nowEpochSec` (it shadowed the module-level `nowEpoch` function). Task 10 builds on the same `buildOption`.

- [ ] **Step 1: Rename the shadowing parameter + add a reduced-motion read**

Change the `buildOption` signature (line 57) and its first lines:

```js
function buildOption(readings, rangeKey, nowEpochSec) {
  const bounds = rangeBounds(rangeKey, nowEpochSec);
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  return {
    animation: !reducedMotion,
    grid: { left: 50, right: 50, top: 30, bottom: 60 },
```

(`grid.bottom` goes from `40` to `60` to make room for the slider. `rangeBounds`'s second argument is now `nowEpochSec`.)

- [ ] **Step 2: Add the `dataZoom` block**

Insert a `dataZoom` array into the returned option (e.g. right after the `legend` block, before `xAxis`):

```js
    dataZoom: [
      { type: "inside" },
      {
        type: "slider",
        height: 18,
        bottom: 8,
        borderColor: "transparent",
        backgroundColor: "rgba(148,163,184,0.08)",
        fillerColor: "rgba(14,165,233,0.18)",
        handleStyle: { color: "#94a3b8" },
        moveHandleStyle: { color: "#94a3b8" },
        dataBackground: {
          lineStyle: { color: "#475569" },
          areaStyle: { color: "#334155" },
        },
        selectedDataBackground: {
          lineStyle: { color: "#0ea5e9" },
          areaStyle: { color: "rgba(14,165,233,0.25)" },
        },
        textStyle: { color: "#94a3b8" },
      },
    ],
```

- [ ] **Step 3: Add the comfort `markLine` to the Vann series**

In the `"Vann"` series object (lines 118–133), add a `markLine` property (e.g. after `itemStyle`):

```js
        markLine: {
          silent: true,
          symbol: "none",
          data: [{ yAxis: COMFORT_TEMP }],
          lineStyle: { color: "#94a3b8", type: "dotted", opacity: 0.6 },
          label: {
            formatter: "behagelig",
            color: "#94a3b8",
            position: "insideEndTop",
          },
        },
```

- [ ] **Step 4: Verify visually**

Run: `python3 -m http.server 8000` → http://localhost:8000/
Expected: a dark slider sits below the chart on every range and a mouse-wheel/drag zooms the plot (inside zoom); a faint dotted horizontal line at 18° is labelled "behagelig". With OS "reduce motion" enabled, switching ranges redraws without the sweep animation.

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: add dataZoom, 18° comfort line, and reduced-motion to the chart"
```

---

## Task 10: Chart — richer Vind tooltip (gust + compass) + empty-params guard

**Files:**
- Modify: `app.js` (`buildOption` tooltip formatter)
- Test: visual (served page)

**Interfaces:**
- Consumes: `degToCompass` (Task 4); the `readings` passed to `buildOption`; reading fields `windGust`, `windDir`.
- Produces: nothing for later tasks (final UI task).

- [ ] **Step 1: Build a ms→reading map at the top of `buildOption`**

Just after the `reducedMotion` line from Task 9, add:

```js
  // ms timestamp → reading, so the tooltip can enrich the Vind row with the
  // gust/direction fields that aren't part of the plotted [ms, value] pairs.
  const byMs = new Map(readings.map((r) => [r.epoch * 1000, r]));
```

- [ ] **Step 2: Replace the tooltip formatter**

Replace the `tooltip.formatter` (lines 63–76) with the guarded, enriched version:

```js
      formatter: (params) => {
        if (!params || !params.length) return "";
        const p = osloParts(params[0].axisValue, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const header = `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`;
        const rows = params
          .map((s) => {
            const value = s.value?.[1] ?? "–";
            let line = `${s.marker}${s.seriesName}: <b>${value}</b>`;
            if (s.seriesName === "Vind") {
              const r = byMs.get(s.value?.[0]);
              if (r && r.windGust != null) {
                const compass = degToCompass(r.windDir);
                const dir =
                  r.windDir != null
                    ? ` · ${r.windDir}°${compass ? ` ${compass}` : ""}`
                    : "";
                line += ` (kast ${r.windGust}${dir})`;
              }
            }
            return line;
          })
          .join("<br>");
        return `${header}<br>${rows}`;
      },
```

- [ ] **Step 3: Verify visually**

Run: `python3 -m http.server 8000` → http://localhost:8000/
Expected: hovering the chart shows the date/time header and per-series rows; the **Vind** row now reads like `Vind: 0,8 (kast 2,6 · 78° Ø)` when gust/direction are present, and falls back to the plain `Vind: 0,8` when they are null. No console error when the cursor leaves the plot area (empty-params guard).

- [ ] **Step 4: Run the full unit suite once more**

Run: `npm test`
Expected: PASS (helpers unchanged here, but confirm nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add app.js
git commit -m "feat: enrich Vind tooltip with gust and compass direction"
```

---

## Self-Review

**Spec coverage** — every spec section maps to a task:
- `waterStats` → Task 1; `isStale` → Task 2; `humanizeAge` → Task 3; `degToCompass` → Task 4; `waterTrend` → Task 5.
- Thresholds constants → Task 6. Header age + stale badge → Task 6. Trend arrow → Task 7. Stats row → Task 8.
- dataZoom + comfort line + reduced motion + `nowEpoch`→`nowEpochSec` rename → Task 9. Richer tooltip + empty-params guard → Task 10.
- Responsive media queries: see Note below — folded into the UI tasks' CSS is the per-element styling; a dedicated responsive sweep is the one item to confirm during execution (added as Task 11 below).

**Note on responsiveness:** The spec calls for a narrow-screen media query (reduce chart height, wrap header/stats) and CSS-level reduced-motion. That is its own reviewable CSS deliverable, so it is split out:

---

## Task 11: Responsive + reduced-motion CSS

**Files:**
- Modify: `styles.css`
- Test: visual (narrow viewport)

**Interfaces:**
- Consumes: the elements/classes added in Tasks 6–8 (`.trend`, `.stats`, `.as-of.stale`) and existing `.header`, `.chart`.
- Produces: nothing for later tasks (final task).

- [ ] **Step 1: Add the media queries in `styles.css`**

Append:

```css
@media (max-width: 600px) {
  body { padding: 16px; }
  .header { align-items: flex-start; }
  .current { text-align: left; }
  .chart { height: 320px; }
  .ranges { flex-wrap: wrap; }
}

@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; }
}
```

- [ ] **Step 2: Verify visually**

Run: `python3 -m http.server 8000` → open http://localhost:8000/ and narrow the window (or use device emulation) to <600px.
Expected: the chart is shorter, the header/current block and range buttons wrap instead of overflowing, and the stats row stays readable. With OS reduce-motion on, no CSS transitions animate.

- [ ] **Step 3: Commit**

```bash
git add styles.css
git commit -m "feat: responsive layout and CSS reduced-motion"
```

---

## Final verification

- [ ] Run `npm test` — all unit tests green.
- [ ] Serve the page and confirm, end to end: stale badge + age, trend arrow, comfort line, dataZoom slider, enriched Vind tooltip, stats row, narrow-viewport layout, reduced-motion.

**Type consistency check:** `nowEpochSec` is the renamed `buildOption` parameter (Task 9), passed `nowEpoch()` by `render` — the module-level `nowEpoch` function is untouched. `updateTrend`/`updateStats` are defined in Tasks 7/8 and both called from `render`. Formatters `signedTemp` (Task 7) and `plainTemp` (Task 8) are distinct. `waterStats`/`isStale`/`humanizeAge`/`degToCompass`/`waterTrend` signatures match between their defining tasks (1–5) and their call sites (6–10).
