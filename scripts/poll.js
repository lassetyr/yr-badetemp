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
