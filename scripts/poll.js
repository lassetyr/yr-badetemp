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
