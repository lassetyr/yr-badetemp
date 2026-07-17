import {
  extractOfficialWater,
  extractForecast,
  buildRow,
  extractReading,
  toRow,
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

// --- Unofficial fallback (delete once YR_API_KEY is verified live) -----------
// Undocumented internal endpoint used before the official-API transition. Its
// GeoJSON carries water + air + wind in one response (no met.no call needed).
const LEGACY_API_URL = "https://www.yr.no/api/v0/watertemperatures/10/541/300";
const LOCATION_ID = "0-10238"; // feature match in the GeoJSON; same as STORAGE_ID

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
