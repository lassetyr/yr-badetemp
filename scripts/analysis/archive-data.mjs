// Read-only data access for the forecast analysis scripts in this folder.
// Uses the public publishable key from src/config.js (RLS grants anon SELECT on
// readings and forecast_archive), so no secrets are needed to run them.
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "../../src/config.js";

export const LOCATION_ID = "0-10238";
const HEADERS = { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}` };

// PostgREST silently caps an unpaged read at 1000 rows, so always page.
export async function readAll(pathAndQuery) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}&limit=1000&offset=${offset}`, { headers: HEADERS });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const batch = await res.json();
    out.push(...batch);
    if (batch.length < 1000) return out;
  }
}

// Every archived projection snapshot, oldest-first.
export function loadArchive() {
  return readAll(
    `forecast_archive?select=hour_epoch,generated_at,payload&location_id=eq.${LOCATION_ID}&order=hour_epoch.asc`,
  );
}

// Readings since `sinceEpoch`, oldest-first, in the camelCase shape scripts/lib.js expects.
export async function loadReadings(sinceEpoch = 0) {
  const rows = await readAll(
    `readings?select=epoch,water,air,wind_speed,wind_dir&location_id=eq.${LOCATION_ID}` +
      `&epoch=gte.${sinceEpoch}&order=epoch.asc`,
  );
  return rows.map((r) => ({ epoch: r.epoch, water: r.water, air: r.air, windSpeed: r.wind_speed, windDir: r.wind_dir }));
}

// Seconds between generation and the projection's seed reading. Large values mean
// the sensor had stopped reporting (e.g. the Oct 2026 outage), so the snapshot
// projects from an old seed and says nothing about the model.
export const seedAgeS = (row) => Date.parse(row.generated_at) / 1000 - row.payload.points[0].epoch;
export const MAX_SEED_AGE_S = 2 * 3600;

// Index of the first reading with epoch >= t (readings epoch-ascending).
export function lowerBound(readings, t) {
  let lo = 0;
  let hi = readings.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    readings[m].epoch < t ? (lo = m + 1) : (hi = m);
  }
  return lo;
}

// The reading nearest t within `tolS`, or null.
export function nearestReading(readings, t, tolS = 15 * 60) {
  const i = lowerBound(readings, t);
  let best = null;
  for (const j of [i - 1, i]) {
    const r = readings[j];
    if (r && Math.abs(r.epoch - t) <= tolS && (!best || Math.abs(r.epoch - t) < Math.abs(best.epoch - t))) best = r;
  }
  return best;
}

// Value at fraction f of the sorted copy of `arr`.
export const quantile = (arr, f) => {
  const s = [...arr].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(f * s.length))];
};
