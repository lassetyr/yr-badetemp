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
