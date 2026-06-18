# Water Temperature Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-cost app that hourly records the water temperature at Dulpen, Holmestrand and displays the history in an interactive chart.

**Architecture:** A GitHub Actions workflow polls the yr.no API hourly and appends each new reading (deduped by source timestamp) to an append-only ndjson file committed in the repo. A static GitHub Pages page fetches that file and renders an ECharts graph with water temperature plus air and wind overlays.

**Tech Stack:** Node.js 20 (built-in `fetch`, `node --test`) for the poller; vanilla HTML/CSS/JS + ECharts (CDN) for the frontend; GitHub Actions + GitHub Pages for hosting. No npm runtime dependencies.

## Global Constraints

- **Node version:** 20+ (relies on built-in global `fetch` and `node --test`). One line each below copied as exact values.
- **No runtime npm dependencies.** Poller and tests use only Node built-ins. Frontend loads ECharts from CDN only.
- **Tracked spot:** Dulpen, Holmestrand — `locationId = "0-10238"`.
- **API endpoint:** `https://www.yr.no/api/v0/watertemperatures/10/541/300`.
- **Data file:** `data/dulpen.ndjson`, append-only, one JSON object per line.
- **Reading object shape (canonical, used everywhere):** `{ time: string, epoch: number, water: number, air: number|null, windSpeed: number|null, windGust: number|null, windDir: number|null }`.
- **Dedupe rule:** append a new reading only when its `epoch` is strictly greater than the last stored reading's `epoch`.
- **Poll cadence:** hourly (`cron: "0 * * * *"`).
- **Cost:** must stay within free GitHub Actions + Pages tiers.

---

### Task 1: Poller library (pure functions)

**Files:**
- Create: `package.json`
- Create: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `extractReading(geojson: object, locationId: string): Reading | null` — finds the feature with the given `locationId` and returns a canonical Reading, or `null` if absent / missing a numeric `waterTemperature`.
  - `parseLastReading(text: string): Reading | null` — returns the last reading parsed from ndjson text, or `null` if empty.
  - `shouldAppend(lastReading: Reading | null, reading: Reading | null): boolean` — true when `reading` exists and is newer than `lastReading` (or there is no `lastReading`).
  - `formatLine(reading: Reading): string` — serializes a Reading to a single-line JSON string (no trailing newline).
  - `Reading` shape is the canonical shape from Global Constraints.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "yr-badetemp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test",
    "poll": "node scripts/poll.js"
  }
}
```

- [ ] **Step 2: Write the failing tests**

Create `test/lib.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReading,
  parseLastReading,
  shouldAppend,
  formatLine,
} from "../scripts/lib.js";

const SAMPLE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        locationId: "0-10238",
        timestamp: "2026-06-18T18:38:27+02:00",
        timestampEpoch: 1781800707,
        waterTemperature: 16.6,
        airTemperature: 23.5,
        windSpeed: 0.8,
        windGust: 2.6,
        windDirection: 78,
      },
    },
    {
      type: "Feature",
      properties: {
        locationId: "0-10060",
        timestamp: "2026-06-18T18:21:40+02:00",
        timestampEpoch: 1781799700,
        waterTemperature: 17.8,
      },
    },
  ],
};

test("extractReading returns canonical reading for the matching spot", () => {
  const r = extractReading(SAMPLE, "0-10238");
  assert.deepEqual(r, {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});

test("extractReading defaults missing optional fields to null", () => {
  const r = extractReading(SAMPLE, "0-10060");
  assert.equal(r.water, 17.8);
  assert.equal(r.air, null);
  assert.equal(r.windSpeed, null);
  assert.equal(r.windGust, null);
  assert.equal(r.windDir, null);
});

test("extractReading returns null when spot is absent", () => {
  assert.equal(extractReading(SAMPLE, "9-99999"), null);
});

test("extractReading returns null when geojson is malformed", () => {
  assert.equal(extractReading({}, "0-10238"), null);
  assert.equal(extractReading(null, "0-10238"), null);
});

test("parseLastReading returns null for empty text", () => {
  assert.equal(parseLastReading(""), null);
  assert.equal(parseLastReading("\n\n"), null);
});

test("parseLastReading returns the last line", () => {
  const text =
    '{"time":"a","epoch":1,"water":10,"air":null,"windSpeed":null,"windGust":null,"windDir":null}\n' +
    '{"time":"b","epoch":2,"water":11,"air":null,"windSpeed":null,"windGust":null,"windDir":null}\n';
  assert.equal(parseLastReading(text).epoch, 2);
});

test("shouldAppend is true when there is no prior reading", () => {
  assert.equal(shouldAppend(null, { epoch: 5 }), true);
});

test("shouldAppend is true only when the new epoch is strictly newer", () => {
  assert.equal(shouldAppend({ epoch: 5 }, { epoch: 6 }), true);
  assert.equal(shouldAppend({ epoch: 5 }, { epoch: 5 }), false);
  assert.equal(shouldAppend({ epoch: 5 }, { epoch: 4 }), false);
});

test("shouldAppend is false when there is no new reading", () => {
  assert.equal(shouldAppend({ epoch: 5 }, null), false);
});

test("formatLine round-trips through parseLastReading", () => {
  const reading = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  };
  assert.equal(formatLine(reading).includes("\n"), false);
  assert.deepEqual(parseLastReading(formatLine(reading) + "\n"), reading);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --test`
Expected: FAIL — `Cannot find module '../scripts/lib.js'`.

- [ ] **Step 4: Write the implementation**

Create `scripts/lib.js`:

```js
// Pure helpers for the water-temperature poller. No I/O here.

const num = (v) => (typeof v === "number" ? v : null);

// Find the feature with `locationId` and return a canonical reading,
// or null if absent or missing a numeric water temperature.
export function extractReading(geojson, locationId) {
  const features = geojson?.features;
  if (!Array.isArray(features)) return null;
  const feature = features.find((f) => f?.properties?.locationId === locationId);
  if (!feature) return null;
  const p = feature.properties;
  if (typeof p.waterTemperature !== "number") return null;
  return {
    time: p.timestamp,
    epoch: p.timestampEpoch,
    water: p.waterTemperature,
    air: num(p.airTemperature),
    windSpeed: num(p.windSpeed),
    windGust: num(p.windGust),
    windDir: num(p.windDirection),
  };
}

// Return the last reading from ndjson text, or null if there are no lines.
export function parseLastReading(text) {
  if (!text) return null;
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

// Append only when the fetched reading is strictly newer than the stored one.
export function shouldAppend(lastReading, reading) {
  if (!reading) return false;
  if (!lastReading) return true;
  return reading.epoch > lastReading.epoch;
}

// Serialize a reading to a single ndjson line (no trailing newline).
export function formatLine(reading) {
  return JSON.stringify({
    time: reading.time,
    epoch: reading.epoch,
    water: reading.water,
    air: reading.air,
    windSpeed: reading.windSpeed,
    windGust: reading.windGust,
    windDir: reading.windDir,
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test`
Expected: PASS — all tests in `test/lib.test.js` green.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/lib.js test/lib.test.js
git commit -m "feat: add poller library with extract/dedupe/format helpers"
```

---

### Task 2: Poller runner + first data reading

**Files:**
- Create: `scripts/poll.js`
- Create: `data/dulpen.ndjson` (produced by running the script)

**Interfaces:**
- Consumes: `extractReading`, `parseLastReading`, `shouldAppend`, `formatLine` from `scripts/lib.js` (Task 1).
- Produces: an executable `node scripts/poll.js` entrypoint that fetches the API, appends a new reading to `data/dulpen.ndjson` when newer, and exits 0 on handled failures (network/missing spot) so the workflow does not error.

- [ ] **Step 1: Write the runner**

Create `scripts/poll.js`:

```js
import { readFile, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  extractReading,
  parseLastReading,
  shouldAppend,
  formatLine,
} from "./lib.js";

const API_URL = "https://www.yr.no/api/v0/watertemperatures/10/541/300";
const LOCATION_ID = "0-10238"; // Dulpen, Holmestrand
const DATA_FILE = "data/dulpen.ndjson";

async function main() {
  let res;
  try {
    res = await fetch(API_URL);
  } catch (err) {
    console.error(`Network error fetching API: ${err.message}`);
    return; // exit 0; next hourly run retries
  }
  if (!res.ok) {
    console.error(`API request failed: ${res.status} ${res.statusText}`);
    return;
  }
  const geojson = await res.json();
  const reading = extractReading(geojson, LOCATION_ID);
  if (!reading) {
    console.error(`Spot ${LOCATION_ID} not found or missing water temperature.`);
    return;
  }
  const existing = existsSync(DATA_FILE) ? await readFile(DATA_FILE, "utf8") : "";
  const last = parseLastReading(existing);
  if (!shouldAppend(last, reading)) {
    console.log("No new reading; skipping append.");
    return;
  }
  await appendFile(DATA_FILE, formatLine(reading) + "\n");
  console.log(`Appended reading: water=${reading.water}C at ${reading.time}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Create the data directory and empty data file**

Run:
```bash
mkdir -p data && : > data/dulpen.ndjson
```
Expected: an empty `data/dulpen.ndjson` exists.

- [ ] **Step 3: Run the poller against the live API to seed the first reading**

Run: `node scripts/poll.js`
Expected: prints `Appended reading: water=<n>C at <timestamp>`.

- [ ] **Step 4: Verify the data file now has exactly one valid JSON line**

Run: `node --test test/seed.check.test.js` is NOT used — instead verify inline:
```bash
node -e "const fs=require('fs');const l=fs.readFileSync('data/dulpen.ndjson','utf8').trim().split('\n').filter(Boolean);console.log('lines:',l.length);JSON.parse(l[0]);console.log('parsed ok:',JSON.parse(l[0]).water)"
```
Expected: `lines: 1` and `parsed ok: <number>`.

- [ ] **Step 5: Verify dedupe by running again immediately**

Run: `node scripts/poll.js`
Expected: prints `No new reading; skipping append.` (the source timestamp has not advanced), and the file still has 1 line:
```bash
wc -l < data/dulpen.ndjson
```
Expected: `1`.

- [ ] **Step 6: Commit**

```bash
git add scripts/poll.js data/dulpen.ndjson
git commit -m "feat: add poller runner and seed first reading"
```

---

### Task 3: GitHub Actions hourly workflow

**Files:**
- Create: `.github/workflows/poll.yml`

**Interfaces:**
- Consumes: `node scripts/poll.js` (Task 2) and `data/dulpen.ndjson`.
- Produces: an hourly workflow that runs the poller and commits `data/dulpen.ndjson` only when it changed. Also runnable manually via `workflow_dispatch`.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/poll.yml`:

```yaml
name: Poll water temperature

on:
  schedule:
    - cron: "0 * * * *" # hourly, on the hour (UTC)
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: poll
  cancel-in-progress: false

jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Fetch and append reading
        run: node scripts/poll.js
      - name: Commit if changed
        run: |
          if [[ -n "$(git status --porcelain data/dulpen.ndjson)" ]]; then
            git config user.name "github-actions[bot]"
            git config user.email "github-actions[bot]@users.noreply.github.com"
            git add data/dulpen.ndjson
            git commit -m "data: add reading $(date -u +%FT%TZ)"
            git push
          else
            echo "No changes to commit."
          fi
```

- [ ] **Step 2: Validate the workflow YAML parses**

Run:
```bash
node -e "const fs=require('fs');const s=fs.readFileSync('.github/workflows/poll.yml','utf8');if(!s.includes('cron: \"0 * * * *\"'))throw new Error('cron missing');if(!s.includes('node scripts/poll.js'))throw new Error('poll step missing');if(!s.includes('contents: write'))throw new Error('write permission missing');console.log('workflow ok')"
```
Expected: `workflow ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/poll.yml
git commit -m "ci: add hourly water-temperature polling workflow"
```

- [ ] **Step 4: (Deferred to Task 6) Live verification**

Note: the workflow can only truly run once the repo is on GitHub. Live verification (trigger `workflow_dispatch`, confirm a `data:` commit appears) is performed in Task 6 after the repo is pushed. No action here beyond the YAML checks above.

---

### Task 4: Frontend data module (pure functions)

**Files:**
- Create: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Consumes: nothing (pure, shares the canonical Reading shape).
- Produces:
  - `parseNdjson(text: string): Reading[]` — parses ndjson text to an array of readings (oldest first), `[]` when empty.
  - `filterByRange(readings: Reading[], rangeKey: "24h"|"7d"|"30d"|"all", nowEpoch: number): Reading[]` — returns readings within the window ending at `nowEpoch`; returns all readings for `"all"` or any unknown key.

- [ ] **Step 1: Write the failing tests**

Create `test/data.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNdjson, filterByRange } from "../src/data.js";

const mk = (epoch) => ({
  time: new Date(epoch * 1000).toISOString(),
  epoch,
  water: 16,
  air: 20,
  windSpeed: 1,
  windGust: 2,
  windDir: 90,
});

test("parseNdjson returns [] for empty text", () => {
  assert.deepEqual(parseNdjson(""), []);
  assert.deepEqual(parseNdjson("\n  \n"), []);
});

test("parseNdjson parses multiple lines in order", () => {
  const text = JSON.stringify(mk(1)) + "\n" + JSON.stringify(mk(2)) + "\n";
  const out = parseNdjson(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].epoch, 1);
  assert.equal(out[1].epoch, 2);
});

test("filterByRange 'all' returns every reading", () => {
  const readings = [mk(100), mk(200)];
  assert.equal(filterByRange(readings, "all", 1000).length, 2);
});

test("filterByRange unknown key returns every reading", () => {
  const readings = [mk(100), mk(200)];
  assert.equal(filterByRange(readings, "nope", 1000).length, 2);
});

test("filterByRange '24h' keeps only readings within the last 24h", () => {
  const now = 1_000_000;
  const day = 24 * 3600;
  const readings = [mk(now - day - 10), mk(now - 10), mk(now)];
  const out = filterByRange(readings, "24h", now);
  assert.equal(out.length, 2);
  assert.equal(out[0].epoch, now - 10);
});

test("filterByRange '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  const within7 = now - 6 * 24 * 3600;
  const within30 = now - 20 * 24 * 3600;
  const old = now - 40 * 24 * 3600;
  const readings = [mk(old), mk(within30), mk(within7), mk(now)];
  assert.equal(filterByRange(readings, "7d", now).length, 2);
  assert.equal(filterByRange(readings, "30d", now).length, 3);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/data.test.js`
Expected: FAIL — `Cannot find module '../src/data.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/data.js`:

```js
// Pure helpers shared by the browser app and unit tests.

// Parse ndjson text into an array of readings, oldest first.
export function parseNdjson(text) {
  if (!text) return [];
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Keep readings within a time window ending at nowEpoch (seconds).
// rangeKey: "24h" | "7d" | "30d" | "all". Unknown keys return all readings.
export function filterByRange(readings, rangeKey, nowEpoch) {
  const windows = {
    "24h": 24 * 3600,
    "7d": 7 * 24 * 3600,
    "30d": 30 * 24 * 3600,
  };
  if (!(rangeKey in windows)) return readings;
  const cutoff = nowEpoch - windows[rangeKey];
  return readings.filter((r) => r.epoch >= cutoff);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/data.test.js`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add frontend data parsing and range-filter helpers"
```

---

### Task 5: Frontend page (chart UI)

**Files:**
- Create: `index.html`
- Create: `app.js`
- Create: `styles.css`
- Create: `.nojekyll`

**Interfaces:**
- Consumes: `parseNdjson`, `filterByRange` from `src/data.js` (Task 4); `data/dulpen.ndjson` (Task 2); ECharts from CDN.
- Produces: a static page that renders water/air/wind series with range toggles and a current-value header. (No automated test — verified by serving locally and observing the chart.)

- [ ] **Step 1: Create `.nojekyll`**

This disables Jekyll processing so GitHub Pages serves `data/*.ndjson` and the JS modules as-is.

```bash
touch .nojekyll
```

- [ ] **Step 2: Write `index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Badetemperatur — Dulpen</title>
    <link rel="stylesheet" href="styles.css" />
    <script src="https://cdn.jsdelivr.net/npm/echarts@5/dist/echarts.min.js"></script>
  </head>
  <body>
    <header class="header">
      <div class="title">
        <h1>Dulpen</h1>
        <p class="subtitle">Badeplass • Holmestrand</p>
      </div>
      <div class="current">
        <span class="temp" id="current-temp">–</span>
        <span class="as-of" id="current-asof"></span>
      </div>
    </header>

    <nav class="ranges" id="ranges">
      <button data-range="24h">24h</button>
      <button data-range="7d">7d</button>
      <button data-range="30d" class="active">30d</button>
      <button data-range="all">All</button>
    </nav>

    <main>
      <div id="chart" class="chart"></div>
      <p class="empty" id="empty" hidden>
        No readings recorded yet. Check back after the first hourly poll.
      </p>
    </main>

    <script type="module" src="app.js"></script>
  </body>
</html>
```

- [ ] **Step 3: Write `app.js`**

```js
import { parseNdjson, filterByRange } from "./src/data.js";

const DATA_URL = "data/dulpen.ndjson";
const chart = echarts.init(document.getElementById("chart"));
let allReadings = [];
let currentRange = "30d";

const nowEpoch = () => Math.floor(Date.now() / 1000);

function buildOption(readings) {
  return {
    grid: { left: 50, right: 50, top: 30, bottom: 40 },
    tooltip: { trigger: "axis" },
    legend: { data: ["Water", "Air", "Wind"], top: 0, right: 8 },
    xAxis: {
      type: "category",
      data: readings.map((r) => r.time),
      axisLabel: {
        formatter: (value) => {
          const d = new Date(value);
          const pad = (n) => String(n).padStart(2, "0");
          return `${d.getDate()}.${d.getMonth() + 1} ${pad(d.getHours())}:00`;
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
        name: "Water",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: readings.map((r) => r.water),
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
        name: "Air",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: readings.map((r) => r.air),
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
      },
      {
        name: "Wind",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        data: readings.map((r) => r.windSpeed),
        lineStyle: { width: 1.5, color: "#94a3b8", type: "dashed" },
        itemStyle: { color: "#94a3b8" },
      },
    ],
  };
}

function render() {
  const readings = filterByRange(allReadings, currentRange, nowEpoch());
  const empty = document.getElementById("empty");
  if (readings.length === 0) {
    empty.hidden = false;
    chart.clear();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(readings), true);
}

function updateHeader() {
  if (allReadings.length === 0) return;
  const latest = allReadings[allReadings.length - 1];
  document.getElementById("current-temp").textContent = `${latest.water}°C`;
  document.getElementById("current-asof").textContent =
    `as of ${new Date(latest.time).toLocaleString()}`;
}

function wireButtons() {
  document.getElementById("ranges").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    currentRange = btn.dataset.range;
    document
      .querySelectorAll("#ranges button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
}

window.addEventListener("resize", () => chart.resize());

async function init() {
  wireButtons();
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    allReadings = res.ok ? parseNdjson(await res.text()) : [];
  } catch {
    allReadings = [];
  }
  updateHeader();
  render();
}

init();
```

- [ ] **Step 4: Write `styles.css`**

```css
:root {
  --bg: #0f172a;
  --panel: #1e293b;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --accent: #0ea5e9;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg);
  color: var(--text);
  padding: 24px;
  max-width: 900px;
  margin-inline: auto;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 12px;
}

.header h1 { margin: 0; font-size: 1.8rem; }
.subtitle { margin: 4px 0 0; color: var(--muted); }

.current { text-align: right; }
.current .temp { font-size: 2.4rem; font-weight: 700; color: var(--accent); }
.current .as-of { display: block; color: var(--muted); font-size: 0.8rem; }

.ranges {
  display: flex;
  gap: 8px;
  margin: 20px 0;
}

.ranges button {
  background: var(--panel);
  color: var(--text);
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 6px 16px;
  cursor: pointer;
  font-size: 0.9rem;
}

.ranges button.active {
  border-color: var(--accent);
  color: var(--accent);
}

.chart {
  width: 100%;
  height: 420px;
  background: var(--panel);
  border-radius: 12px;
  padding: 8px;
}

.empty { color: var(--muted); text-align: center; padding: 40px; }
```

- [ ] **Step 5: Serve locally and verify the chart renders**

Run (from repo root): `python3 -m http.server 8000`
Then open `http://localhost:8000/` in a browser.
Expected:
- Header shows "Dulpen" and a current temperature with an "as of" time (from the seeded reading).
- The chart renders a water-temperature line with a blue gradient fill (a single seeded point may show as a dot — this is expected until more readings accumulate).
- Clicking 24h / 7d / 30d / All toggles the active button without errors (check the browser console is clean).
Stop the server with Ctrl-C when done.

- [ ] **Step 6: Commit**

```bash
git add index.html app.js styles.css .nojekyll
git commit -m "feat: add ECharts water-temperature page with range toggles"
```

---

### Task 6: Publish to GitHub + README

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: a published GitHub repo with the hourly workflow running and a live GitHub Pages site; a README documenting setup and the one-time Pages configuration.

- [ ] **Step 1: Write `README.md`**

```markdown
# yr-badetemp — Water Temperature Tracker

Hourly records the water temperature at **Dulpen, Holmestrand** from the
[yr.no](https://www.yr.no) water-temperatures API and shows the history in an
interactive chart. No server, no database — GitHub Actions polls, the repo
stores the data, GitHub Pages serves the chart.

## How it works

- `.github/workflows/poll.yml` runs hourly, executes `scripts/poll.js`, and
  commits a new line to `data/dulpen.ndjson` when the source reading is newer.
- `index.html` + `app.js` fetch that file and render it with ECharts.

## Local development

```bash
npm test                 # run unit tests (Node 20+, no dependencies)
node scripts/poll.js     # fetch one reading into data/dulpen.ndjson
python3 -m http.server 8000   # then open http://localhost:8000/
```

## One-time GitHub setup

1. Create a GitHub repo and push this project to the `main` branch.
2. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`,
   folder: `/ (root)` → Save. The site appears at
   `https://<user>.github.io/<repo>/`.
3. **Settings → Actions → General** → Workflow permissions →
   **Read and write permissions** → Save (lets the workflow push data commits).
4. **Actions** tab → run the **Poll water temperature** workflow once via
   *Run workflow* to confirm it appends and commits a reading.

## Configuration

- Tracked spot: `LOCATION_ID = "0-10238"` in `scripts/poll.js`.
- Poll cadence: the `cron` in `.github/workflows/poll.yml`.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with setup and Pages instructions"
```

- [ ] **Step 3: Create the GitHub repo and push**

Run:
```bash
gh repo create yr-badetemp --private --source=. --remote=origin --push
```
Expected: repo created and `main` pushed. (If `gh` is not authenticated, run `gh auth login` first, or create the repo in the web UI and `git remote add origin <url> && git push -u origin main`.)

- [ ] **Step 4: Configure Pages and Actions permissions**

Follow README steps 2–3 in the GitHub web UI (Pages source = `main` root; Actions workflow permissions = read and write).

- [ ] **Step 5: Trigger the workflow and verify the live pipeline**

Run:
```bash
gh workflow run "Poll water temperature"
gh run watch
```
Expected: the run succeeds. Then confirm either `No changes to commit.` (if the source timestamp has not advanced since seeding) or a new `data: add reading ...` commit:
```bash
git pull --ff-only
wc -l < data/dulpen.ndjson
```
Expected: the workflow completed successfully and the data file is intact (1 or more lines).

- [ ] **Step 6: Verify the live site loads**

Open `https://<user>.github.io/yr-badetemp/` in a browser.
Expected: the page loads, header shows the latest reading, and the chart renders. (Allow a minute for the first Pages deploy.)
```
