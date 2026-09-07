# Unofficial-endpoint Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the poller degrade gracefully — use the official Yr + met.no path when `YR_API_KEY` is set, and fall back to the pre-transition unofficial GeoJSON endpoint when it is not — so the branch keeps collecting data until the key lands.

**Architecture:** `scripts/poll.js` gains a provider switch. `main()` picks `pollOfficial()` (key set) or `pollUnofficial()` (key absent), each returning a ready-to-insert row or `null`, then hands it to a shared `insertRow()`. All pure parsing already lives in `scripts/lib.js` (`extractOfficialWater`/`extractForecast`/`buildRow` for official; `extractReading`/`toRow` for unofficial) and is already unit-tested — this plan adds no new pure logic.

**Tech Stack:** Node 22 ES modules, zero runtime deps, `node --test` for tests, `fetch` for I/O, Supabase PostgREST as the sink.

## Global Constraints

- Zero runtime dependencies; native ES modules (`"type": "module"`). — verbatim from repo conventions
- Both providers write `location_id = "0-10238"` so new rows line up with existing history. `STORAGE_ID` (official) and `LOCATION_ID` (unofficial) are the same value.
- Both providers are **water-anchored and fail soft**: any network/HTTP/parse failure, or a missing water reading, returns `null`; `main()` then inserts nothing and the process exits 0.
- Trigger is **missing-key-only**: an official-API *runtime* failure skips the poll — it does NOT fall back to unofficial.
- The unofficial path is a **temporary scaffold** — keep it in its own function backed by its own helpers so it lifts out cleanly at cutover.
- Insert stays idempotent via `Prefer: resolution=ignore-duplicates` against the `(location_id, epoch)` PK. Do not add UPDATE/DELETE.
- **No new unit tests** (no new pure logic). Verification is the existing suite (regression) plus manual smoke runs of `poll.js`.

---

### Task 1: Refactor the official path into `pollOfficial()` + `insertRow()` (no behavior change)

Pull the inline insert and official-flow logic out of `main()` into two focused functions, leaving observable behavior identical. This isolates the seam the switch plugs into next.

**Files:**
- Modify: `scripts/poll.js` (rewrite `main()`, add `insertRow`, add `pollOfficial`; `fetchWater`/`fetchForecast`/constants unchanged)
- Test: none added — `test/lib.test.js` is the regression guard

**Interfaces:**
- Consumes: `extractOfficialWater`, `extractForecast`, `buildRow` from `./lib.js` (unchanged imports); module constants `WATER_API_URL`, `FORECAST_API_URL`, `MET_USER_AGENT`, `STORAGE_ID`, `YR_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.
- Produces: `async insertRow(row) → Promise<boolean>` (true on successful insert, false on any soft failure); `async pollOfficial() → Promise<row|null>` where `row` is the snake_case shape `{ location_id, epoch, time, water, air, wind_speed, wind_gust, wind_dir }`.

- [ ] **Step 1: Add `insertRow()` above `main()`**

Insert this function (it is the current inline insert block, lifted verbatim and returning a boolean instead of falling through):

```js
// Insert one row into Supabase. Returns true on success, false on any failure.
// All failures are soft — the run exits 0 and the next scheduled poll retries.
async function insertRow(row) {
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
    return false;
  }
  if (!insert.ok) {
    console.error(`Insert failed: ${insert.status} ${insert.statusText}`);
    return false;
  }
  return true;
}
```

- [ ] **Step 2: Add `pollOfficial()` below `insertRow()`**

```js
// Official path: Yr water (anchor) + met.no weather (optional). Returns a
// ready-to-insert row, or null when there is no water reading this poll.
async function pollOfficial() {
  console.log("Polling via official API");
  const water = await fetchWater();
  if (!water) {
    console.error("No water temperature available; skipping insert.");
    return null; // water-anchored: no water, no row
  }
  const forecast = await fetchForecast(); // null → water-only row
  return buildRow(water, forecast, STORAGE_ID);
}
```

- [ ] **Step 3: Replace `main()` with the slimmed version**

Replace the entire existing `main()` (the version that inlines the water/forecast/insert logic) with:

```js
async function main() {
  if (!YR_API_KEY) {
    console.error("Missing YR_API_KEY.");
    return; // exit 0; next scheduled run retries
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    return;
  }
  const row = await pollOfficial();
  if (!row) return;
  const ok = await insertRow(row);
  if (ok) console.log(`Inserted reading: water=${row.water}C at ${row.time}`);
}
```

Leave `fetchWater`, `fetchForecast`, the constants, and the `main().catch(...)` tail exactly as they are.

- [ ] **Step 4: Run the test suite (regression)**

Run: `npm test`
Expected: PASS — all existing `test/lib.test.js` cases green (no test files changed).

- [ ] **Step 5: Verify control flow with a smoke run (no creds needed)**

Run: `node scripts/poll.js`
Expected: prints `Missing YR_API_KEY.` and exits 0 (unchanged guard).

Run: `YR_API_KEY=dummy node scripts/poll.js`
Expected: prints `Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.` and exits 0 — confirms the key guard now passes through to the Supabase guard.

- [ ] **Step 6: Commit**

```bash
git add scripts/poll.js
git commit -m "refactor: extract pollOfficial() and insertRow() from main()"
```

---

### Task 2: Add `pollUnofficial()` and switch on `YR_API_KEY`

Restore the pre-transition unofficial fetch as one self-contained provider and route to it when the key is absent. This is the behavior change: the branch stops going inert without a key.

**Files:**
- Modify: `scripts/poll.js` (add legacy import + constants, add `pollUnofficial`, replace the `YR_API_KEY` guard in `main()` with the provider switch)
- Modify: `CLAUDE.md` (poller description + config knobs now reflect dual-mode)
- Test: none added — regression via `test/lib.test.js`

**Interfaces:**
- Consumes: `insertRow`, `pollOfficial` from Task 1; `extractReading`, `toRow` from `./lib.js`.
- Produces: `async pollUnofficial() → Promise<row|null>` returning the same snake_case row shape as `pollOfficial()`; a `main()` with no standalone `YR_API_KEY` guard.

- [ ] **Step 1: Extend the `lib.js` import**

Change the import at the top of `scripts/poll.js` from:

```js
import { extractOfficialWater, extractForecast, buildRow } from "./lib.js";
```

to:

```js
import {
  extractOfficialWater,
  extractForecast,
  buildRow,
  extractReading,
  toRow,
} from "./lib.js";
```

- [ ] **Step 2: Add the legacy endpoint constants**

Directly below the `// --- Endpoints ---` block (after `MET_USER_AGENT`), add:

```js
// --- Unofficial fallback (delete once YR_API_KEY is verified live) -----------
// Undocumented internal endpoint used before the official-API transition. Its
// GeoJSON carries water + air + wind in one response (no met.no call needed).
const LEGACY_API_URL = "https://www.yr.no/api/v0/watertemperatures/10/541/300";
const LOCATION_ID = "0-10238"; // feature match in the GeoJSON; same as STORAGE_ID
```

- [ ] **Step 3: Add `pollUnofficial()` below `pollOfficial()`**

```js
// Unofficial fallback: one GeoJSON call carrying water + air + wind. Used only
// when YR_API_KEY is unset. Returns a ready-to-insert row, or null on failure.
async function pollUnofficial() {
  console.log("Polling via unofficial API (YR_API_KEY unset)");
  let res;
  try {
    res = await fetch(LEGACY_API_URL);
  } catch (err) {
    console.error(`Network error fetching legacy API: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    console.error(`Legacy API request failed: ${res.status} ${res.statusText}`);
    return null;
  }
  let geojson;
  try {
    geojson = await res.json();
  } catch (err) {
    console.error(`Malformed legacy API response: ${err.message}`);
    return null;
  }
  const reading = extractReading(geojson, LOCATION_ID);
  if (!reading) {
    console.error(`Spot ${LOCATION_ID} not found or missing water temperature.`);
    return null;
  }
  return toRow(reading, LOCATION_ID);
}
```

- [ ] **Step 4: Replace the key guard in `main()` with the provider switch**

In `main()`, delete the `if (!YR_API_KEY) { ... return; }` block and change the row line to pick a provider. `main()` becomes:

```js
async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    return;
  }
  const row = YR_API_KEY ? await pollOfficial() : await pollUnofficial();
  if (!row) return;
  const ok = await insertRow(row);
  if (ok) console.log(`Inserted reading: water=${row.water}C at ${row.time}`);
}
```

- [ ] **Step 5: Run the test suite (regression)**

Run: `npm test`
Expected: PASS — unchanged, all `test/lib.test.js` cases green.

- [ ] **Step 6: Verify both routes with smoke runs**

Routing without live Supabase (no writes; just confirms the switch picks the right provider before the Supabase guard would stop a keyless official run):

Run: `YR_API_KEY=dummy node scripts/poll.js`
Expected: prints `Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.` (Supabase guard first).

Full unofficial path (needs real Supabase creds; inserts a real Dulpen reading — idempotent, safe to repeat):

Run: `SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js`
Expected: prints `Polling via unofficial API (YR_API_KEY unset)` then `Inserted reading: water=<n>C at <iso>`.

Official routing with a bad key (needs Supabase creds; confirms `YR_API_KEY` set → official provider, then fails soft on the bad key without inserting):

Run: `YR_API_KEY=dummy SUPABASE_URL=<url> SUPABASE_SERVICE_KEY=<sb_secret_...> node scripts/poll.js`
Expected: prints `Polling via official API` then `Water API request failed: 401 ...` (or 403) then `No water temperature available; skipping insert.` — no insert.

- [ ] **Step 7: Update `CLAUDE.md` for dual-mode**

In the **Poller** bullet under `## Architecture`, append a sentence after the existing description:

```markdown
  When `YR_API_KEY` is unset the poller instead falls back to the pre-transition
  unofficial GeoJSON endpoint (`www.yr.no/api/v0/watertemperatures/...`, one call
  carrying water + air + wind) via `extractReading`/`toRow` — a temporary
  scaffold so data keeps flowing until the key lands; it is removed at cutover.
```

In the `## Config knobs` **Secrets** bullet, change the `YR_API_KEY` line to note it is now optional:

```markdown
- Secrets: `YR_API_KEY` (official water API; **optional** — unset falls back to
  the unofficial endpoint), plus `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`.
```

- [ ] **Step 8: Commit**

```bash
git add scripts/poll.js CLAUDE.md
git commit -m "feat: fall back to unofficial endpoint when YR_API_KEY is unset"
```

---

## Cutover cleanup — **DONE 2026-09-07** (key verified live; run logged `Polling via official API`)

Recorded here so it is not forgotten. When the official path is confirmed working with a real `YR_API_KEY`:

(One addition the list missed: `scripts/import-history.js` also imported `toRow`. The
mapping was inlined there instead, since the frozen ndjson archive is its only input.)

1. In `scripts/poll.js`: delete `pollUnofficial()`, the `LEGACY_API_URL`/`LOCATION_ID` constants, and the `extractReading`/`toRow` names from the import; change `main()`'s row line back to `const row = await pollOfficial();` and restore the `if (!YR_API_KEY) { ... }` guard at the top.
2. In `scripts/lib.js`: delete `extractReading` and `toRow`.
3. In `test/lib.test.js`: delete the `extractReading`/`toRow` test cases and drop them from the import.
4. In `CLAUDE.md`: revert the two dual-mode edits from Task 2, Step 7.

---

## Self-Review

**Spec coverage:**
- Provider switch on missing-key-only → Task 2, Step 4. ✓
- `pollOfficial`/`pollUnofficial`/shared `insertRow` structure → Tasks 1–2. ✓
- No new pure logic / no new unit tests; regression via existing suite → both tasks, Step "Run the test suite". ✓
- Legacy constants grouped as an obvious scaffold → Task 2, Step 2. ✓
- Startup log line per path → Task 1 Step 2 (`Polling via official API`) + Task 2 Step 3 (`Polling via unofficial API (YR_API_KEY unset)`). ✓
- Water-anchored fail-soft, both paths → `pollOfficial`/`pollUnofficial` both `return null` on failure; `main()` inserts nothing. ✓
- Idempotent insert unchanged → `insertRow` keeps `Prefer: resolution=ignore-duplicates`. ✓
- Clean removal path → dedicated "Cutover cleanup" section. ✓
- No schema/frontend/attribution change → nothing in either task touches them. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; `<url>`/`<sb_secret_...>` in Step 6/verification are genuine credential placeholders the operator fills, matching the repo's documented command style, not plan gaps.

**Type consistency:** `insertRow(row) → boolean`, `pollOfficial() → row|null`, `pollUnofficial() → row|null` used consistently across tasks. Both providers emit the identical snake_case row (`buildRow` and `toRow` are byte-for-byte the same shape — verified in `lib.js`), so `insertRow` and the shared success log (`row.water`, `row.time`) are provider-agnostic. `STORAGE_ID === LOCATION_ID === "0-10238"`.
