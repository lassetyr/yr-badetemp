# Supabase + Cloudflare Pages Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move yr-badetemp's data layer from `data/dulpen.ndjson`-in-git to a Supabase Postgres table, served to a static chart hosted on Cloudflare Pages from a private GitHub repo, reproducing today's behavior exactly.

**Architecture:** The existing two-halves split is preserved — the poller (CI/Node) and the browser app share pure helpers in `scripts/lib.js` / `src/data.js` but never import each other. Only the data layer changes: the poller `INSERT`s via the Supabase PostgREST API instead of appending to a file, and the frontend `fetch`es the PostgREST endpoint instead of the ndjson file. Append-only idempotency is enforced by a `(location_id, epoch)` primary key plus `ON CONFLICT DO NOTHING`, replacing the `shouldAppend` check.

**Tech Stack:** Node 22 (CI), native `fetch`, `node --test` (zero deps), Supabase (Postgres + PostgREST + RLS), Cloudflare Pages, ECharts (CDN), native ES modules.

## Global Constraints

- Zero runtime dependencies; no build step, no bundler. Tests run with `node --test` on Node 20+.
- Pure logic lives in `scripts/lib.js` and `src/data.js` (no network/DOM/fs); side effects live in `scripts/poll.js`, `scripts/import-history.js`, and `app.js`.
- Poller failures `return` (process exits 0) so a transient blip waits for the next scheduled poll. The one-off import script is the exception: it exits non-zero on failure (fail loud).
- Tracked spot in v1: `LOCATION_ID = "0-10238"` (Dulpen, Holmestrand). The `location_id` column exists as the multi-location seam but only this value is written.
- Append-only invariant: never update/delete/reorder rows; re-inserting an existing `(location_id, epoch)` must be a no-op.
- All user-facing time stays rendered in `Europe/Oslo`; UI labels stay Norwegian.
- The anon key is shipped in client code by design (read-only via RLS). The `service_role` key is never committed — GitHub Actions secret / local env only.

---

### Task 1: Provision Supabase project, schema, and RLS

**Files:**
- Create: `supabase/schema.sql`

**Interfaces:**
- Produces: a `readings` table reachable at `${SUPABASE_URL}/rest/v1/readings` with columns `location_id, epoch, time, water, air, wind_speed, wind_gust, wind_dir`; public `SELECT` via the `anon` role; writes only via `service_role`.

- [ ] **Step 1: Create the Supabase project**

In the Supabase dashboard (supabase.com) create a new free-tier project. Once it finishes provisioning, go to **Project Settings → API** and note three values for later tasks:
- Project URL (e.g. `https://abcdefgh.supabase.co`) → used as `SUPABASE_URL`
- `anon` `public` key → used as `SUPABASE_ANON_KEY`
- `service_role` `secret` key → used as `SUPABASE_SERVICE_KEY` (keep private)

- [ ] **Step 2: Write the schema file**

Create `supabase/schema.sql`:

```sql
-- yr-badetemp Supabase schema. Run once in the Supabase SQL editor.

create table if not exists readings (
  location_id text not null,
  epoch       bigint not null,
  time        timestamptz not null,
  water       double precision not null,
  air         double precision,
  wind_speed  double precision,
  wind_gust   double precision,
  wind_dir    double precision,
  primary key (location_id, epoch)
);

-- Public read-only access for the static chart. Writes use the service_role
-- key, which bypasses RLS.
alter table readings enable row level security;

create policy "Public read access"
  on readings
  for select
  to anon
  using (true);
```

- [ ] **Step 3: Run the schema in Supabase**

Open the Supabase **SQL Editor**, paste the contents of `supabase/schema.sql`, and run it.

- [ ] **Step 4: Verify the table exists and is empty**

In the SQL Editor run:

```sql
select count(*) from readings;
```

Expected: `0`.

- [ ] **Step 5: Commit**

```bash
git add supabase/schema.sql
git commit -m "feat: add Supabase readings schema and RLS policy"
```

---

### Task 2: Poller pure helpers — add `toRow`, remove file-era helpers

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `extractReading(geojson, locationId)` (unchanged).
- Produces: `toRow(reading, locationId)` → `{ location_id, epoch, time, water, air, wind_speed, wind_gust, wind_dir }`. Removes `parseLastReading`, `shouldAppend`, and `formatLine` (no longer used once the poller writes to Postgres).

- [ ] **Step 1: Rewrite the test file to drop file-era helpers and add `toRow` tests**

Replace the imports and the `parseLastReading` / `shouldAppend` / `formatLine` tests in `test/lib.test.js`. The new top of the file and new tests (keep the existing `extractReading` tests and the `SAMPLE` constant exactly as they are):

Change the import block at the top to:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReading, toRow } from "../scripts/lib.js";
```

Delete the four tests named `parseLastReading...`, `shouldAppend...`, and `formatLine round-trips...` (lines 69–107 in the current file). Append these in their place:

```js
test("toRow maps a reading to the snake_case row payload", () => {
  const reading = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  };
  assert.deepEqual(toRow(reading, "0-10238"), {
    location_id: "0-10238",
    epoch: 1781800707,
    time: "2026-06-18T18:38:27+02:00",
    water: 16.6,
    air: 23.5,
    wind_speed: 0.8,
    wind_gust: 2.6,
    wind_dir: 78,
  });
});

test("toRow preserves null optional fields", () => {
  const reading = {
    time: "t",
    epoch: 1,
    water: 17.8,
    air: null,
    windSpeed: null,
    windGust: null,
    windDir: null,
  };
  const row = toRow(reading, "0-10060");
  assert.equal(row.air, null);
  assert.equal(row.wind_speed, null);
  assert.equal(row.wind_gust, null);
  assert.equal(row.wind_dir, null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/lib.test.js`
Expected: FAIL — `toRow` is not exported (`The requested module '../scripts/lib.js' does not provide an export named 'toRow'`).

- [ ] **Step 3: Update `scripts/lib.js`**

Keep the `num` helper and `extractReading` exactly as they are. Delete `parseLastReading`, `shouldAppend`, and `formatLine`. Append `toRow`:

```js
// Map a reading to the snake_case row payload for the readings table.
export function toRow(reading, locationId) {
  return {
    location_id: locationId,
    epoch: reading.epoch,
    time: reading.time,
    water: reading.water,
    air: reading.air,
    wind_speed: reading.windSpeed,
    wind_gust: reading.windGust,
    wind_dir: reading.windDir,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/lib.test.js`
Expected: PASS (all `extractReading` and `toRow` tests green).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: add toRow helper, drop file-era poller helpers"
```

---

### Task 3: Rewrite `poll.js` to insert via PostgREST

**Files:**
- Modify: `scripts/poll.js`

**Interfaces:**
- Consumes: `extractReading`, `toRow` from `scripts/lib.js`; env `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- Produces: a `node scripts/poll.js` run that inserts one reading and is idempotent on re-run.

- [ ] **Step 1: Replace `scripts/poll.js` entirely**

```js
import { extractReading, toRow } from "./lib.js";

const API_URL = "https://www.yr.no/api/v0/watertemperatures/10/541/300";
const LOCATION_ID = "0-10238"; // Dulpen, Holmestrand
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    return; // exit 0; next scheduled run retries
  }
  let res;
  try {
    res = await fetch(API_URL);
  } catch (err) {
    console.error(`Network error fetching API: ${err.message}`);
    return;
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
  const row = toRow(reading, LOCATION_ID);
  let insert;
  try {
    insert = await fetch(`${SUPABASE_URL}/rest/v1/readings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        // ON CONFLICT DO NOTHING against the (location_id, epoch) primary key,
        // so re-runs and overlapping schedules are idempotent.
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify(row),
    });
  } catch (err) {
    console.error(`Network error inserting reading: ${err.message}`);
    return;
  }
  if (!insert.ok) {
    console.error(`Insert failed: ${insert.status} ${insert.statusText}`);
    return;
  }
  console.log(`Inserted reading: water=${reading.water}C at ${reading.time}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Run a poll locally against Supabase**

```bash
SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
SUPABASE_SERVICE_KEY="YOUR_SERVICE_ROLE_KEY" \
node scripts/poll.js
```

Expected: `Inserted reading: water=...C at ...`.

- [ ] **Step 3: Verify the row landed**

In the Supabase SQL Editor:

```sql
select location_id, time, water from readings order by epoch desc limit 1;
```

Expected: one row for `0-10238` with the temperature just printed.

- [ ] **Step 4: Verify idempotency**

Run the same command from Step 2 again immediately. Expected: it prints `Inserted reading: ...` again (the API reading is unchanged), but the row count does not increase:

```sql
select count(*) from readings;
```

Expected: still `1` (the duplicate `epoch` was ignored). If the API has since produced a newer reading, you may legitimately see `2` — confirm by checking the two epochs differ.

- [ ] **Step 5: Commit**

```bash
git add scripts/poll.js
git commit -m "feat: poll inserts readings into Supabase via PostgREST"
```

---

### Task 4: One-off history import script

**Files:**
- Create: `scripts/import-history.js`

**Interfaces:**
- Consumes: `toRow` from `scripts/lib.js`; reads `data/dulpen.ndjson`; env `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- Produces: every historical reading inserted into `readings` under `location_id = "0-10238"`. Idempotent and re-runnable.

- [ ] **Step 1: Create `scripts/import-history.js`**

```js
import { readFile } from "node:fs/promises";
import { toRow } from "./lib.js";

const DATA_FILE = "data/dulpen.ndjson";
const LOCATION_ID = "0-10238";
const BATCH_SIZE = 500;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    process.exit(1);
  }
  const text = await readFile(DATA_FILE, "utf8");
  const readings = text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const rows = readings.map((r) => toRow(r, LOCATION_ID));
  console.log(`Importing ${rows.length} readings...`);

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const res = await fetch(`${SUPABASE_URL}/rest/v1/readings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      console.error(
        `Batch ${i}-${i + batch.length} failed: ${res.status} ${await res.text()}`,
      );
      process.exit(1);
    }
    console.log(`Imported ${Math.min(i + BATCH_SIZE, rows.length)}/${rows.length}`);
  }
  console.log("Import complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Count the source lines for later comparison**

```bash
grep -c . data/dulpen.ndjson
```

Note this number (call it `N`).

- [ ] **Step 3: Run the import**

```bash
SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
SUPABASE_SERVICE_KEY="YOUR_SERVICE_ROLE_KEY" \
node scripts/import-history.js
```

Expected: `Importing N readings...`, progress lines, then `Import complete.`.

- [ ] **Step 4: Verify the row count matches**

In the Supabase SQL Editor:

```sql
select count(*) from readings where location_id = '0-10238';
```

Expected: `N` (or `N` plus any rows already inserted by the Task 3 poll test — at most a couple more). If it is much lower, a batch silently deduped against itself only if the ndjson had duplicate epochs; investigate before continuing.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-history.js
git commit -m "feat: add one-off ndjson history import script"
```

---

### Task 5: Update the poll workflow

**Files:**
- Modify: `.github/workflows/poll.yml`

**Interfaces:**
- Consumes: GitHub Actions secrets `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- Produces: a scheduled workflow that runs `node scripts/poll.js` with no git commit/push.

- [ ] **Step 1: Set the GitHub Actions secrets**

```bash
gh secret set SUPABASE_URL --body "https://YOUR_PROJECT.supabase.co"
gh secret set SUPABASE_SERVICE_KEY --body "YOUR_SERVICE_ROLE_KEY"
```

(Or set them via the GitHub UI: **Settings → Secrets and variables → Actions**.)

- [ ] **Step 2: Replace `.github/workflows/poll.yml`**

```yaml
name: Poll water temperature

on:
  schedule:
    # Offset off :00/:20/:40 — those minutes are the most congested on
    # GitHub's shared scheduler and scheduled runs there get dropped most often.
    - cron: "7,27,47 * * * *" # every 20 minutes, off-peak (UTC)
  workflow_dispatch:

concurrency:
  group: poll
  cancel-in-progress: false

jobs:
  poll:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Fetch and insert reading
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
        run: node scripts/poll.js
```

(The `permissions: contents: write` block and the entire "Commit if changed" step are removed — the poller no longer writes to the repo.)

- [ ] **Step 3: Commit and push**

```bash
git add .github/workflows/poll.yml
git commit -m "ci: poll workflow inserts to Supabase, no git commit"
git push
```

- [ ] **Step 4: Trigger the workflow manually and verify**

```bash
gh workflow run "Poll water temperature"
```

Wait ~30s, then:

```bash
gh run list --workflow "Poll water temperature" --limit 1
```

Expected: the latest run concludes `success`. Confirm a fresh row in Supabase (`select max(time) from readings;`) is recent.

---

### Task 6: Frontend pure helpers — query-URL builder and row mapper

**Files:**
- Modify: `src/data.js`
- Test: `test/data.test.js`

**Interfaces:**
- Produces:
  - `readingsQueryUrl(baseUrl, locationId, rangeKey, nowEpoch)` → a PostgREST URL string selecting `time,epoch,water,air,wind_speed,wind_gust,wind_dir` for `location_id = eq.<id>`, ordered `epoch.asc`, with `epoch=gte.<cutoff>` for `24h`/`7d`/`30d` and no epoch bound for `all`/unknown.
  - `mapRow(row)` → `{ time, epoch, water, air, windSpeed, windGust, windDir }`.
- Removes `parseNdjson` and `filterByRange` (range filtering moves server-side).

- [ ] **Step 1: Replace `test/data.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readingsQueryUrl, mapRow } from "../src/data.js";

const BASE = "https://proj.supabase.co";

test("readingsQueryUrl targets the readings endpoint, filters by location, orders by epoch", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "all", 1000));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/readings`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  assert.equal(url.searchParams.get("order"), "epoch.asc");
  assert.equal(
    url.searchParams.get("select"),
    "time,epoch,water,air,wind_speed,wind_gust,wind_dir",
  );
});

test("readingsQueryUrl 'all' omits the epoch lower bound", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "all", 1000));
  assert.equal(url.searchParams.get("epoch"), null);
});

test("readingsQueryUrl unknown range omits the epoch lower bound", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "nope", 1000));
  assert.equal(url.searchParams.get("epoch"), null);
});

test("readingsQueryUrl '24h' sets epoch >= now - 24h", () => {
  const now = 1_000_000;
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "24h", now));
  assert.equal(url.searchParams.get("epoch"), `gte.${now - 24 * 3600}`);
});

test("readingsQueryUrl '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  const u7 = new URL(readingsQueryUrl(BASE, "0-10238", "7d", now));
  const u30 = new URL(readingsQueryUrl(BASE, "0-10238", "30d", now));
  assert.equal(u7.searchParams.get("epoch"), `gte.${now - 7 * 24 * 3600}`);
  assert.equal(u30.searchParams.get("epoch"), `gte.${now - 30 * 24 * 3600}`);
});

test("mapRow converts snake_case columns to the camelCase reading shape", () => {
  const row = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    wind_speed: 0.8,
    wind_gust: 2.6,
    wind_dir: 78,
  };
  assert.deepEqual(mapRow(row), {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/data.test.js`
Expected: FAIL — `readingsQueryUrl` / `mapRow` not exported.

- [ ] **Step 3: Replace `src/data.js`**

```js
// Pure helpers shared by the browser app and unit tests. No network/DOM here.

const RANGE_SECONDS = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
};

const COLUMNS = "time,epoch,water,air,wind_speed,wind_gust,wind_dir";

// Build a PostgREST query URL for one location and time range. baseUrl is the
// Supabase project URL with no trailing slash. Unknown/"all" ranges omit the
// epoch lower bound (return the full history).
export function readingsQueryUrl(baseUrl, locationId, rangeKey, nowEpoch) {
  const params = new URLSearchParams();
  params.set("select", COLUMNS);
  params.set("location_id", `eq.${locationId}`);
  params.set("order", "epoch.asc");
  if (rangeKey in RANGE_SECONDS) {
    params.set("epoch", `gte.${nowEpoch - RANGE_SECONDS[rangeKey]}`);
  }
  return `${baseUrl}/rest/v1/readings?${params.toString()}`;
}

// Map a PostgREST row (snake_case) to the camelCase reading shape the chart
// consumes.
export function mapRow(row) {
  return {
    time: row.time,
    epoch: row.epoch,
    water: row.water,
    air: row.air,
    windSpeed: row.wind_speed,
    windGust: row.wind_gust,
    windDir: row.wind_dir,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/data.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data.js test/data.test.js
git commit -m "feat: add PostgREST query-url builder and row mapper"
```

---

### Task 7: Frontend read-path rewrite — `config.js` + `app.js`

**Files:**
- Create: `src/config.js`
- Modify: `app.js`

**Interfaces:**
- Consumes: `readingsQueryUrl`, `mapRow` from `src/data.js`; `SUPABASE_URL`, `SUPABASE_ANON_KEY` from `src/config.js`.
- Produces: a chart that fetches the selected range from Supabase and re-fetches on range change and on the refresh timer.

- [ ] **Step 1: Create `src/config.js` with your project's public values**

Paste the real Project URL and `anon` public key from Task 1, Step 1 (these are safe to commit — RLS makes the anon key read-only):

```js
// Public Supabase config. The anon key is read-only via Row Level Security and
// is intended to ship in client code.
export const SUPABASE_URL = "https://YOUR_PROJECT.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";
```

- [ ] **Step 2: Update the imports and constants at the top of `app.js`**

Replace the first three lines:

```js
import { parseNdjson, filterByRange } from "./src/data.js";

const DATA_URL = "data/dulpen.ndjson";
```

with:

```js
import { readingsQueryUrl, mapRow } from "./src/data.js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./src/config.js";

const LOCATION_ID = "0-10238"; // Dulpen, Holmestrand
```

- [ ] **Step 3: Simplify `render()` to use `allReadings` directly**

Range filtering is now server-side, so `render` no longer filters. Replace the current `render` function:

```js
function render() {
  const empty = document.getElementById("empty");
  if (allReadings.length === 0) {
    empty.hidden = false;
    chart.clear();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(allReadings), true);
}
```

- [ ] **Step 4: Rewrite `loadData()` to fetch from Supabase**

Replace the current `loadData` function:

```js
// Fetch the current range from Supabase and re-render. On failure, leave the
// existing readings and chart intact — a transient network blip must not blank
// a working chart. Returns true when fresh data was applied.
async function loadData() {
  const url = readingsQueryUrl(SUPABASE_URL, LOCATION_ID, currentRange, nowEpoch());
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    allReadings = rows.map(mapRow);
  } catch {
    return false;
  }
  updateHeader();
  render();
  return true;
}
```

- [ ] **Step 5: Make the range buttons re-fetch instead of re-render**

In `wireButtons`, the click handler currently ends with `render();`. Because the data for a range now comes from the server, change that line to re-fetch. Replace:

```js
    syncRangeButtons();
    render();
  });
```

with:

```js
    syncRangeButtons();
    loadData();
  });
```

- [ ] **Step 6: Serve the site locally and verify it reads from Supabase**

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000/`. Expected:
- The chart renders the imported history (the default `30d` range).
- The header shows the latest water temperature and an "oppdatert ..." timestamp in Oslo time.
- Clicking `24t` / `7d` / `30d` / `alle` swaps the visible window (watch the Network tab: each click issues a new request to `.../rest/v1/readings?...` with a different `epoch=gte.` value; `alle` has none).
- In the browser console there are no CORS or 401 errors.

- [ ] **Step 7: Commit**

```bash
git add src/config.js app.js
git commit -m "feat: frontend reads readings from Supabase PostgREST"
```

---

### Task 8: Cutover — Cloudflare Pages, private repo, disable GitHub Pages

**Files:** none (operational).

**Interfaces:**
- Consumes: the pushed repo with all prior tasks merged.
- Produces: the live chart served from Cloudflare Pages out of a private repo; GitHub Pages disabled.

- [ ] **Step 1: Push everything**

```bash
git push
```

Confirm the working tree is clean and all tasks are committed.

- [ ] **Step 2: Connect Cloudflare Pages to the repo**

In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**. Authorize the repo. Configure the build:
- Framework preset: **None**
- Build command: *(leave empty)*
- Build output directory: `/` (repo root — `index.html` is at the root)

Deploy. Cloudflare gives a `*.pages.dev` URL.

- [ ] **Step 3: Verify the Cloudflare deployment works**

Open the `*.pages.dev` URL. Expected: identical behavior to the local verification in Task 7, Step 6 — chart loads, ranges switch, no console errors. (This is the gate: confirm hosting works **before** going private.)

- [ ] **Step 4: Make the GitHub repo private**

GitHub: **Settings → General → Danger Zone → Change repository visibility → Make private**.

- [ ] **Step 5: Confirm Cloudflare Pages still builds from the now-private repo**

Make a trivial commit (e.g. touch a comment) and push, or use Cloudflare's **Retry deployment**. Expected: the deployment succeeds — the Git integration retains access after the visibility change.

- [ ] **Step 6: Disable GitHub Pages**

GitHub: **Settings → Pages → Source → None** (or delete the `gh-pages` deployment if one exists). The old `*.github.io` URL stops serving.

- [ ] **Step 7: Confirm the poller keeps the data flowing**

Wait for (or manually trigger) the next scheduled poll, then reload the Cloudflare site. Expected: the header timestamp advances as new readings arrive, confirming the end-to-end loop (Actions → Supabase → Cloudflare) works. The frozen `data/dulpen.ndjson` remains in the repo as a historical backup and is no longer written.

---

## Notes for the implementer

- **`data/dulpen.ndjson` is intentionally left in the repo** after migration as a frozen historical backup. Do not delete it and do not wire anything to append to it.
- **`scripts/trigger.sh`** (the external-scheduler doc/helper) still works unchanged — it hits `workflow_dispatch`, which Task 5 keeps.
- If `CLAUDE.md` is updated to reflect the new architecture, that is a reasonable follow-up commit but is out of scope for these tasks.
