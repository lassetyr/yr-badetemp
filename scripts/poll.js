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
