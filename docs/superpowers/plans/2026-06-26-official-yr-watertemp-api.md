# Official Yr Water-Temp API Transition (Hybrid) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the poller off the undocumented `www.yr.no/api/v0/watertemperatures` endpoint onto the official `badetemperaturer.yr.no` API, sourcing air/wind from MET Norway Locationforecast 2.0 so the chart keeps its water+air+wind parity.

**Architecture:** `poll.js` does two independent fetches per run — water temperature from `badetemperaturer.yr.no` (auth via `apikey` header) and air/wind from `api.met.no` (auth via `User-Agent`) — then writes one water-anchored row to Supabase. All parsing lives in pure helpers in `lib.js`; all I/O stays in `poll.js`. Storage location ID stays `0-10238` so new readings line up with existing history.

**Tech Stack:** Node 22 (CI) / Node 20+ (tests), zero runtime dependencies, `node --test`, native ES modules, `fetch`. Supabase PostgREST. Static frontend (ECharts via CDN).

## Global Constraints

- Zero runtime dependencies; tests use only `node:test` + `node:assert/strict`. (verbatim from CLAUDE.md)
- Pure logic (no network/DOM) goes in `scripts/lib.js`; side effects stay in `scripts/poll.js`.
- `STORAGE_ID` written to `readings.location_id` MUST remain `"0-10238"`.
- Inserts keep `Prefer: resolution=ignore-duplicates` against the `(location_id, epoch)` PK — readings are append-only; no UPDATE/DELETE write path.
- Required attribution strings, exact: `Badetemperaturer levert av Yr` and `Værdata fra MET Norway`.
- met.no requires an identifying `User-Agent`: `yr-badetemp/1.0 (github.com/lassetyr/yr-badetemp; lassetyr@gmail.com)`.
- Dulpen coordinates: `LAT = 59.49233`, `LON = 10.31529`.
- Failure model: water-anchored. Water fetch fails → no row. Weather fetch fails → water-only row with null air/wind. All failures `return` (process exits 0).
- ES module syntax (`import`/`export`), matching existing files.

---

## File Structure

- `scripts/lib.js` (modify) — add `extractOfficialWater`, `extractForecast`, `buildRow`; remove legacy `extractReading`/`toRow` at cutover (Task 8).
- `test/lib.test.js` (modify) — add tests for the three new helpers; remove legacy tests at cutover (Task 8).
- `scripts/poll.js` (rewrite) — hybrid two-fetch flow.
- `index.html` (modify) — attribution footer.
- `styles.css` (modify) — `.credits` styling.
- `.github/workflows/poll.yml` (modify) — add `YR_API_KEY` to the job env.
- `CLAUDE.md` (modify) — update architecture/config-knobs prose.

Tasks 1–3 are merge-safe (additive helpers + tests, no behavior change). Tasks 4–7 build the new path on the branch. Task 8 is the key-gated verification + cutover.

---

### Task 1: `extractOfficialWater` helper

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractOfficialWater(json) -> { temperature: number, time: string, epoch: number } | null`. Picks the entry with the newest parseable `time`; `epoch = Math.floor(Date.parse(time)/1000)`. Returns `null` for a non-array, empty array, or array with no numeric-temperature/parseable-time entries.

- [ ] **Step 1: Write the failing tests**

First, extend the existing import line at the top of `test/lib.test.js` so it pulls in all three new helpers alongside the legacy ones (single import line, no duplicate):

```javascript
import {
  extractReading,
  toRow,
  extractOfficialWater,
  extractForecast,
  buildRow,
} from "../scripts/lib.js";
```

Then append the new sample + tests to `test/lib.test.js`:

```javascript
const OFFICIAL_WATER = [
  { temperature: 16, time: "2022-06-14T10:17:54+02:00" },
  { temperature: 19, time: "2021-08-13T06:17:52+02:00" },
  { temperature: 11, time: "2021-10-19T06:17:54+02:00" },
];

test("extractOfficialWater returns the newest reading regardless of array order", () => {
  assert.deepEqual(extractOfficialWater(OFFICIAL_WATER), {
    temperature: 16,
    time: "2022-06-14T10:17:54+02:00",
    epoch: Math.floor(Date.parse("2022-06-14T10:17:54+02:00") / 1000),
  });
});

test("extractOfficialWater skips entries with non-numeric temperature", () => {
  const r = extractOfficialWater([
    { temperature: null, time: "2022-06-14T10:17:54+02:00" },
    { temperature: 12, time: "2022-06-13T10:17:54+02:00" },
  ]);
  assert.equal(r.temperature, 12);
});

test("extractOfficialWater returns null for empty array, non-array, and unparseable times", () => {
  assert.equal(extractOfficialWater([]), null);
  assert.equal(extractOfficialWater(null), null);
  assert.equal(extractOfficialWater({}), null);
  assert.equal(
    extractOfficialWater([{ temperature: 12, time: "not-a-date" }]),
    null,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — `extractOfficialWater` (and `extractForecast`/`buildRow`) are not exported yet (SyntaxError / undefined import).

- [ ] **Step 3: Implement `extractOfficialWater`**

Add to `scripts/lib.js`:

```javascript
// Find the newest official water reading in the array and return a canonical
// shape, or null if empty/malformed. The official API returns up to 5 entries
// of { temperature, time }, newest-first, but we pick by time rather than trust
// the order.
export function extractOfficialWater(json) {
  if (!Array.isArray(json)) return null;
  let best = null;
  for (const entry of json) {
    if (typeof entry?.temperature !== "number") continue;
    const epoch = Math.floor(Date.parse(entry.time) / 1000);
    if (!Number.isFinite(epoch)) continue;
    if (!best || epoch > best.epoch) {
      best = { temperature: entry.temperature, time: entry.time, epoch };
    }
  }
  return best;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib.test.js`
Expected: the three `extractOfficialWater` tests PASS. (`extractForecast`/`buildRow` tests still fail — added in Tasks 2–3.)

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: add extractOfficialWater helper for official Yr API"
```

---

### Task 2: `extractForecast` helper

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractForecast(json) -> { air, windSpeed, windGust, windDir }`. Each field is a `number` or `null`. Reads `json.properties.timeseries[0].data.instant.details` and maps `air_temperature→air`, `wind_speed→windSpeed`, `wind_speed_of_gust→windGust`, `wind_from_direction→windDir`. Never returns null itself — a missing/malformed shape yields all-null fields.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib.test.js`:

```javascript
const FORECAST = {
  properties: {
    timeseries: [
      {
        data: {
          instant: {
            details: {
              air_temperature: 23.5,
              wind_speed: 0.8,
              wind_speed_of_gust: 2.6,
              wind_from_direction: 78,
            },
          },
        },
      },
    ],
  },
};

test("extractForecast maps met.no instant details to camelCase", () => {
  assert.deepEqual(extractForecast(FORECAST), {
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});

test("extractForecast returns all-null fields for a malformed shape", () => {
  assert.deepEqual(extractForecast({}), {
    air: null,
    windSpeed: null,
    windGust: null,
    windDir: null,
  });
  assert.deepEqual(extractForecast(null), {
    air: null,
    windSpeed: null,
    windGust: null,
    windDir: null,
  });
});

test("extractForecast nulls individually missing fields", () => {
  const partial = {
    properties: {
      timeseries: [
        { data: { instant: { details: { air_temperature: 18 } } } },
      ],
    },
  };
  assert.deepEqual(extractForecast(partial), {
    air: 18,
    windSpeed: null,
    windGust: null,
    windDir: null,
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — `extractForecast` not exported.

- [ ] **Step 3: Implement `extractForecast`**

Add to `scripts/lib.js`:

```javascript
// Pull instant air/wind from a met.no Locationforecast 2.0 response. Returns an
// object with all-null fields if any part of the expected shape is missing.
export function extractForecast(json) {
  const details = json?.properties?.timeseries?.[0]?.data?.instant?.details;
  return {
    air: num(details?.air_temperature),
    windSpeed: num(details?.wind_speed),
    windGust: num(details?.wind_speed_of_gust),
    windDir: num(details?.wind_from_direction),
  };
}
```

(`num` already exists at the top of `lib.js`: `const num = (v) => (typeof v === "number" ? v : null);`)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/lib.test.js`
Expected: the `extractForecast` tests PASS (`buildRow` tests still fail).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: add extractForecast helper for met.no Locationforecast"
```

---

### Task 3: `buildRow` helper

**Files:**
- Modify: `scripts/lib.js`
- Test: `test/lib.test.js`

**Interfaces:**
- Consumes: `extractOfficialWater` output (`{temperature,time,epoch}`) and `extractForecast` output (`{air,windSpeed,windGust,windDir}` or `null`).
- Produces: `buildRow(water, forecast, locationId) -> { location_id, epoch, time, water, air, wind_speed, wind_gust, wind_dir }`. `forecast` may be `null` (weather fetch failed) → air/wind columns become `null`.

- [ ] **Step 1: Write the failing tests**

Append to `test/lib.test.js`:

```javascript
test("buildRow combines water and forecast into a snake_case row", () => {
  const water = { temperature: 16.6, time: "2026-06-18T18:38:27+02:00", epoch: 1781800707 };
  const forecast = { air: 23.5, windSpeed: 0.8, windGust: 2.6, windDir: 78 };
  assert.deepEqual(buildRow(water, forecast, "0-10238"), {
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

test("buildRow nulls air/wind when forecast is null (weather fetch failed)", () => {
  const water = { temperature: 16.6, time: "t", epoch: 1 };
  const row = buildRow(water, null, "0-10238");
  assert.equal(row.water, 16.6);
  assert.equal(row.air, null);
  assert.equal(row.wind_speed, null);
  assert.equal(row.wind_gust, null);
  assert.equal(row.wind_dir, null);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/lib.test.js`
Expected: FAIL — `buildRow` not exported.

- [ ] **Step 3: Implement `buildRow`**

Add to `scripts/lib.js`:

```javascript
// Combine an official water reading with an optional forecast into the
// snake_case readings row. forecast may be null when the weather fetch failed;
// the air/wind columns are nullable and the chart tolerates gaps.
export function buildRow(water, forecast, locationId) {
  return {
    location_id: locationId,
    epoch: water.epoch,
    time: water.time,
    water: water.temperature,
    air: forecast?.air ?? null,
    wind_speed: forecast?.windSpeed ?? null,
    wind_gust: forecast?.windGust ?? null,
    wind_dir: forecast?.windDir ?? null,
  };
}
```

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all new helper tests plus the pre-existing legacy `extractReading`/`toRow` and `data.test.js` tests.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "feat: add buildRow helper for official-API readings"
```

---

### Task 4: Rewrite `poll.js` for the hybrid flow

**Files:**
- Rewrite: `scripts/poll.js`

**Interfaces:**
- Consumes: `extractOfficialWater`, `extractForecast`, `buildRow` from `./lib.js`.
- Produces: a runnable poller. New env var read: `YR_API_KEY`. Constants `STORAGE_ID="0-10238"`, `QUERY_ID="0-10238"` (verified/adjusted in Task 8), `LAT`, `LON`.

> No unit test for `poll.js` — it is the I/O shell (CLAUDE.md keeps it logic-free). It is exercised live in Task 8. This task's gate is "runs and reports missing-key cleanly without the secret set."

- [ ] **Step 1: Replace the contents of `scripts/poll.js`**

```javascript
import { extractOfficialWater, extractForecast, buildRow } from "./lib.js";

// --- Tracked spot -----------------------------------------------------------
const STORAGE_ID = "0-10238"; // written to readings.location_id (history continuity)
// What badetemperaturer.yr.no expects. Assumed equal to STORAGE_ID; confirmed or
// replaced during the key-gated verification step (see the plan, Task 8).
const QUERY_ID = "0-10238";
const LAT = 59.49233; // Dulpen, Holmestrand
const LON = 10.31529;

// --- Endpoints --------------------------------------------------------------
const WATER_API_URL = `https://badetemperaturer.yr.no/api/locations/${QUERY_ID}/watertemperatures`;
const FORECAST_API_URL = `https://api.met.no/weatherapi/locationforecast/2.0/complete?lat=${LAT}&lon=${LON}`;
const MET_USER_AGENT =
  "yr-badetemp/1.0 (github.com/lassetyr/yr-badetemp; lassetyr@gmail.com)";

// --- Secrets ----------------------------------------------------------------
const YR_API_KEY = process.env.YR_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Fetch the latest official water reading. Returns a canonical reading or null
// (network/HTTP/parse failure) — water is the anchor, so null means "no row".
async function fetchWater() {
  let res;
  try {
    res = await fetch(WATER_API_URL, { headers: { apikey: YR_API_KEY } });
  } catch (err) {
    console.error(`Network error fetching water API: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    console.error(`Water API request failed: ${res.status} ${res.statusText}`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error(`Malformed water API response: ${err.message}`);
    return null;
  }
  return extractOfficialWater(json);
}

// Fetch air/wind from met.no. Returns a forecast object or null; a null here is
// non-fatal — the poll still inserts a water-only row.
async function fetchForecast() {
  let res;
  try {
    res = await fetch(FORECAST_API_URL, { headers: { "User-Agent": MET_USER_AGENT } });
  } catch (err) {
    console.error(`Network error fetching forecast API: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    console.error(`Forecast API request failed: ${res.status} ${res.statusText}`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    console.error(`Malformed forecast API response: ${err.message}`);
    return null;
  }
  return extractForecast(json);
}

async function main() {
  if (!YR_API_KEY) {
    console.error("Missing YR_API_KEY.");
    return; // exit 0; next scheduled run retries
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    return;
  }

  const water = await fetchWater();
  if (!water) {
    console.error("No water temperature available; skipping insert.");
    return; // water-anchored: no water, no row
  }
  const forecast = await fetchForecast(); // null → water-only row

  const row = buildRow(water, forecast, STORAGE_ID);
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
  console.log(
    `Inserted reading: water=${water.temperature}C at ${water.time} (air=${forecast?.air ?? "n/a"})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify the missing-key guard (no secrets set)**

Run: `node scripts/poll.js`
Expected: prints `Missing YR_API_KEY.` and exits 0 (no throw). (It exits before any network call because `YR_API_KEY` is unset locally.)

- [ ] **Step 3: Verify the full test suite still passes**

Run: `npm test`
Expected: PASS (poll.js has no unit tests; this confirms the import rewrite didn't break `lib.js`).

- [ ] **Step 4: Commit**

```bash
git add scripts/poll.js
git commit -m "feat: poll official Yr water API + met.no weather (hybrid)"
```

---

### Task 5: Frontend attribution

**Files:**
- Modify: `index.html`
- Modify: `styles.css`

**Interfaces:** none (static markup + CSS).

- [ ] **Step 1: Add the attribution footer to `index.html`**

Insert immediately after the closing `</main>` tag (before `<script type="module" src="app.js"></script>`):

```html
    <footer class="credits">
      Badetemperaturer levert av Yr · Værdata fra MET Norway
    </footer>
```

- [ ] **Step 2: Add `.credits` styling to `styles.css`**

Append to `styles.css`:

```css
.credits {
  margin: 1.5rem 0 0.5rem;
  text-align: center;
  font-size: 0.8rem;
  opacity: 0.6;
}
```

- [ ] **Step 3: Visually verify**

Run: `python3 -m http.server 8000`
Then open `http://localhost:8000/` and confirm the line **"Badetemperaturer levert av Yr · Værdata fra MET Norway"** is visible below the chart. Stop the server (Ctrl-C).

- [ ] **Step 4: Commit**

```bash
git add index.html styles.css
git commit -m "feat: add required Yr + MET Norway attribution"
```

---

### Task 6: Add `YR_API_KEY` to the poll workflow

**Files:**
- Modify: `.github/workflows/poll.yml`

**Interfaces:** the workflow now passes `YR_API_KEY` into `node scripts/poll.js`.

- [ ] **Step 1: Add the env var**

In `.github/workflows/poll.yml`, change the `env:` block of the "Fetch and insert reading" step from:

```yaml
        env:
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

to:

```yaml
        env:
          YR_API_KEY: ${{ secrets.YR_API_KEY }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_KEY: ${{ secrets.SUPABASE_SERVICE_KEY }}
```

- [ ] **Step 2: Lint the YAML by eye**

Confirm indentation matches the surrounding keys (6 spaces under `env:`). No tool run needed.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/poll.yml
git commit -m "ci: pass YR_API_KEY to the poll workflow"
```

> The `YR_API_KEY` repository secret must be created in GitHub (Settings → Secrets → Actions) before Task 8. Note this for the human; it cannot be done from code.

---

### Task 7: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Update the "What this is" + Poller architecture prose**

In `CLAUDE.md`, update the Poller bullet under **Architecture** to describe the two sources. Replace the existing Poller bullet:

```markdown
- **Poller** (`scripts/poll.js` → `scripts/lib.js`): runs in CI/Node. `poll.js`
  does all I/O (fetch yr.no, POST to Supabase); `lib.js` is pure (`extractReading`
  pulls a reading from the yr.no GeoJSON, `toRow` maps it to the snake_case DB
  row). Failures `return` rather than throw — the run exits 0 so a transient API
  blip just waits for the next scheduled poll.
```

with:

```markdown
- **Poller** (`scripts/poll.js` → `scripts/lib.js`): runs in CI/Node. `poll.js`
  does all I/O — water temperature from the official `badetemperaturer.yr.no`
  API (`apikey` header), air/wind from MET Norway Locationforecast 2.0
  (`User-Agent` header), then POSTs one water-anchored row to Supabase. `lib.js`
  is pure: `extractOfficialWater` picks the newest official water reading,
  `extractForecast` pulls instant air/wind from the met.no response, `buildRow`
  maps them to the snake_case DB row. Failures `return` rather than throw — the
  run exits 0, and a met.no blip still yields a water-only row (air/wind null).
```

- [ ] **Step 2: Update the "Config knobs" section**

Replace the "Tracked spot" + "Supabase" knobs:

```markdown
- Tracked spot: `LOCATION_ID = "0-10238"` and `API_URL` in `scripts/poll.js`
  (`LOCATION_ID` is also set in `app.js` for the read query).
```

with:

```markdown
- Tracked spot: `STORAGE_ID` (written to `location_id`), `QUERY_ID` (sent to
  badetemperaturer.yr.no), and `LAT`/`LON` in `scripts/poll.js`. `STORAGE_ID`
  (`"0-10238"`) is also the read-query id in `app.js`. The water + forecast
  endpoint URLs and `MET_USER_AGENT` are constants in `scripts/poll.js`.
- Secrets: `YR_API_KEY` (official water API, GitHub Actions secret + local env),
  plus the existing `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.
```

- [ ] **Step 3: Update the Commands block poller invocation**

Replace:

```bash
SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js
```

with:

```bash
YR_API_KEY=<key> SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for official Yr API + met.no hybrid"
```

---

### Task 8: Key-gated verification & legacy cleanup

> **BLOCKED until the `YR_API_KEY` arrives from support@yr.no and is set locally + as a GitHub secret.** Do not start until then. This task confirms the API works for Dulpen, then removes the dead GeoJSON code path.

**Files:**
- Modify: `scripts/poll.js` (only if `QUERY_ID` must change)
- Modify: `scripts/lib.js` (remove legacy helpers)
- Modify: `test/lib.test.js` (remove legacy tests + sample)

**Interfaces:** after this task `lib.js` exports only `extractOfficialWater`, `extractForecast`, `buildRow`.

- [ ] **Step 1: Confirm Dulpen resolves on the official API**

Run (substitute the real key):

```bash
curl -s -H "apikey: $YR_API_KEY" \
  "https://badetemperaturer.yr.no/api/locations/0-10238/watertemperatures"
```

Expected: a JSON array of `{temperature,time}` objects.
- If it returns data → `QUERY_ID = "0-10238"` is correct; leave `poll.js` as is.
- If it 404s or returns `[]` → run the coordinate fallback:

```bash
curl -s -H "apikey: $YR_API_KEY" \
  "https://badetemperaturer.yr.no/api/locations/59.49233,10.31529/nearestwatertemperatures"
```

Find the entry whose `locationName` is Dulpen, copy its `locationId`, set `QUERY_ID` in `scripts/poll.js` to that value, and commit:

```bash
git add scripts/poll.js
git commit -m "fix: use Dulpen's official locationId for the water API"
```

- [ ] **Step 2: Run one real poll end-to-end**

Run (all secrets set):

```bash
YR_API_KEY=$YR_API_KEY SUPABASE_URL=$SUPABASE_URL SUPABASE_SERVICE_KEY=$SUPABASE_SERVICE_KEY node scripts/poll.js
```

Expected: prints `Inserted reading: water=<n>C at <iso> (air=<n>)`. Confirm `water` is a plausible temperature and `air` is a number (not `n/a`).

- [ ] **Step 3: Confirm the row landed and is consistent with history**

Query Supabase (PostgREST) for the latest row:

```bash
curl -s -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
  "$SUPABASE_URL/rest/v1/readings?location_id=eq.0-10238&order=epoch.desc&limit=1"
```

Expected: one row with `location_id":"0-10238"`, sane `water`/`air`/`wind_*`, and an `epoch` matching the printed `time`. (Use the publishable key from `src/config.js`.)

- [ ] **Step 4: Trigger the workflow manually to confirm CI path**

With the `YR_API_KEY` GitHub secret set, from the `feat/official-yr-watertemp-api` branch:

```bash
GITHUB_TOKEN=<pat> ./scripts/trigger.sh
```

Expected: HTTP 204, and the workflow run succeeds (check Actions). `main`'s cron is still running the old poller in parallel — compare a couple of points to confirm the water values agree within rounding.

- [ ] **Step 5: Remove the legacy GeoJSON helpers**

In `scripts/lib.js`, delete `extractReading` and the old `toRow` (the two functions that consume the yr.no GeoJSON / `{time,epoch,water,...}` reading shape). Keep `num`, `extractOfficialWater`, `extractForecast`, `buildRow`.

- [ ] **Step 6: Remove the legacy tests**

In `test/lib.test.js`, delete the `SAMPLE` GeoJSON constant and every `test(...)` that calls `extractReading` or the old two-arg `toRow`. Keep the new helper tests. Update the top `import` to drop `extractReading`/`toRow`:

```javascript
import { extractOfficialWater, extractForecast, buildRow } from "../scripts/lib.js";
```

- [ ] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS with no reference to `extractReading`/old `toRow`.

- [ ] **Step 8: Commit**

```bash
git add scripts/lib.js test/lib.test.js
git commit -m "refactor: drop legacy GeoJSON poller path after cutover"
```

- [ ] **Step 9: Merge to main (cutover)**

Open a PR from `feat/official-yr-watertemp-api` and merge once green. After merge, the scheduled cron uses the official path; the unofficial `www.yr.no/api/v0` endpoint is no longer called. `data/dulpen.ndjson` stays frozen.

---

## Self-Review

**Spec coverage:**
- Official API (apikey, endpoints, water-only payload) → Tasks 1, 4, 8. ✅
- Hybrid air/wind from met.no Locationforecast `complete` → Tasks 2, 4. ✅
- Water-anchored failure model → Task 4 (`fetchWater` null → return; `fetchForecast` null → water-only row), Task 3 (`buildRow` null forecast). ✅
- Decoupled `STORAGE_ID` vs `QUERY_ID` → Task 4 constants, Task 8 resolution. ✅
- `epoch` derived from ISO time → Task 1. ✅
- Schema unchanged → no task needed (verified: `air`/`wind_*` already nullable). ✅
- Attribution strings → Task 5. ✅
- `YR_API_KEY` secret + env → Tasks 4, 6. ✅
- met.no `User-Agent` → Task 4 constant. ✅
- Key-gated rollout with parallel comparison → Task 8. ✅
- Docs (CLAUDE.md) → Task 7. ✅
- Decisions: `complete` not `compact` (Task 2 uses `wind_speed_of_gust`); >5-day-empty → skip (Task 4 `fetchWater` null → return). ✅

**Placeholder scan:** No TBD/TODO; every code step has full code. `QUERY_ID` is a concrete value with an explicit verify-or-replace procedure in Task 8 (not a placeholder). ✅

**Type consistency:** `extractOfficialWater` → `{temperature,time,epoch}` consumed by `buildRow(water,...)` as `water.temperature/time/epoch` ✅. `extractForecast` → `{air,windSpeed,windGust,windDir}` consumed by `buildRow` as `forecast?.air/windSpeed/windGust/windDir` ✅. `buildRow` row keys match `readings` columns and the existing `mapRow`/`COLUMNS` in `src/data.js` ✅.

**Test import:** Task 1 extends the single existing import line in `test/lib.test.js` to include the three new helpers; Task 8 trims the legacy symbols back out. One import line throughout.
