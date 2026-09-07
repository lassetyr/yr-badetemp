import {
  extractOfficialWater,
  extractForecast,
  extractForecastSeries,
  buildRow,
  buildProjection,
  hourBucket,
  HORIZON_H,
  FIT_WINDOW_DAYS,
} from "./lib.js";

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

// Append one snapshot of the projection for later calibration of INFLATE against
// real met.no forecast error (the payload's points carry the raw forecast air/wind
// alongside our projected water, so one row records both what we predicted and the
// weather input it came from). Keyed by the hour bucket, so only the first poll of
// each hour lands and the rest are ignore-duplicate no-ops. Fail-soft, and only
// failures are logged — a "archived" line on every poll would be misleading when
// most polls are deliberate no-ops.
async function archiveForecast(payload, generatedAt) {
  const epochSec = Math.floor(generatedAt.getTime() / 1000);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/forecast_archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        // ON CONFLICT (location_id, hour_epoch) DO NOTHING.
        Prefer: "resolution=ignore-duplicates",
      },
      body: JSON.stringify({
        location_id: STORAGE_ID,
        hour_epoch: hourBucket(epochSec),
        generated_at: generatedAt.toISOString(),
        payload,
      }),
    });
    if (!res.ok) {
      console.error(`Forecast archive failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`Network error archiving forecast: ${err.message}`);
    return false;
  }
}

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
        console.error(`History query failed (page ${page}, offset ${page * PAGE}): ${res.status} ${res.statusText}`);
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

// Upsert the single forecast row for this location (replace-on-write via the
// location_id primary key). Returns true on success, false on any failure.
async function upsertForecast(payload, generatedAt) {
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
        generated_at: generatedAt.toISOString(),
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
  try {
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
    const generatedAt = new Date();
    const payload = buildProjection(history, series, { horizonH: HORIZON_H });
    if (await upsertForecast(payload, generatedAt)) {
      console.log(`Projection updated: model=${payload.model}, points=${payload.points.length}`);
    }
    await archiveForecast(payload, generatedAt); // hourly snapshot; no-op most polls
  } catch (err) {
    console.error(`Projection build failed: ${err.message}`);
  }
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
  const row = await pollOfficial();
  if (row) {
    const ok = await insertRow(row);
    if (ok) console.log(`Inserted reading: water=${row.water}C at ${row.time}`);
  }
  await updateForecast(); // fail-soft projection refresh; never blocks the insert
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
