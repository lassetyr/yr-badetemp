// The poll itself: fetch water + weather, insert readings, refresh the forecast.
// scripts/poll.js is the entry point (GitHub Actions, the Raspberry Pi timer in
// pi/, or by hand); it reads the secrets from the environment and calls runPoll.
// Secrets and the fetch implementation arrive in `config` rather than being read
// here, which is what lets the tests run a whole poll against a fake fetch.
//
// All I/O lives here; the pure logic stays in lib.js.
import {
  extractOfficialWaters,
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

// --- Network ----------------------------------------------------------------
// Every call below is fail-soft, but a stalled connection (socket open, server
// never responds) never rejects — a bare fetch would await forever and hang the
// whole poll past its slot. Abort each request after FETCH_TIMEOUT_MS so the
// stall surfaces as an ordinary rejection the existing catch blocks handle
// (→ []/null/false), and the next poll retries. Well under the workflow's
// per-step cap; these APIs answer in well under a second when healthy.
const FETCH_TIMEOUT_MS = 15_000;
function fetchWithTimeout(cfg, url, options = {}) {
  return cfg.fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

// Fetch the official water readings (the endpoint serves the five most recent).
// Returns them oldest-first, or [] on network/HTTP/parse failure — water is the
// anchor, so an empty list means "no rows this poll".
async function fetchWaters(cfg) {
  let res;
  try {
    res = await fetchWithTimeout(cfg, WATER_API_URL, { headers: { apikey: cfg.yrApiKey } });
  } catch (err) {
    cfg.log.error(`Network error fetching water API: ${err.message}`);
    return [];
  }
  if (!res.ok) {
    cfg.log.error(`Water API request failed: ${res.status} ${res.statusText}`);
    return [];
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    cfg.log.error(`Malformed water API response: ${err.message}`);
    return [];
  }
  return extractOfficialWaters(json);
}

// Fetch air/wind from met.no. Returns a forecast object or null; a null here is
// non-fatal — the poll still inserts a water-only row.
async function fetchForecast(cfg) {
  let res;
  try {
    res = await fetchWithTimeout(cfg, FORECAST_API_URL, { headers: { "User-Agent": MET_USER_AGENT } });
  } catch (err) {
    cfg.log.error(`Network error fetching forecast API: ${err.message}`);
    return null;
  }
  if (!res.ok) {
    cfg.log.error(`Forecast API request failed: ${res.status} ${res.statusText}`);
    return null;
  }
  let json;
  try {
    json = await res.json();
  } catch (err) {
    cfg.log.error(`Malformed forecast API response: ${err.message}`);
    return null;
  }
  return extractForecast(json);
}

// Insert readings into Supabase. Returns the rows actually written (PostgREST
// echoes only those, so re-sent overlap from the previous poll doesn't inflate
// the count) or null on failure. All failures are soft — the run exits 0 and
// the next scheduled poll retries.
async function insertRows(cfg, rows) {
  let insert;
  try {
    insert = await fetchWithTimeout(cfg, `${cfg.supabaseUrl}/rest/v1/readings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseServiceKey,
        Authorization: `Bearer ${cfg.supabaseServiceKey}`,
        // ON CONFLICT DO NOTHING against the (location_id, epoch) primary key.
        // Every poll re-sends up to four readings it already stored, so this is
        // the mechanism that makes overlapping polls free rather than an error.
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify(rows),
    });
  } catch (err) {
    cfg.log.error(`Network error inserting readings: ${err.message}`);
    return null;
  }
  if (!insert.ok) {
    cfg.log.error(`Insert failed: ${insert.status} ${insert.statusText}`);
    return null;
  }
  try {
    return await insert.json();
  } catch {
    return []; // written, but the echo was unreadable — don't fail the poll
  }
}

// Official path: Yr water (anchor) + met.no weather (optional). Returns the
// ready-to-insert rows, oldest-first, or [] when this poll has no water reading.
//
// Every returned reading gets THIS poll's met.no air/wind. met.no's instant
// values are hourly-granular, so consecutive polls within an hour already share
// one value — stamping the five readings (≈50 min) alike is the same
// approximation the feed has always carried, and the 24h smoothing that drives
// the fit makes the offset irrelevant. Leaving air null on the backfilled rows
// would instead break the chart's air and wind lines, which split at nulls.
async function pollOfficial(cfg) {
  cfg.log.log("Polling via official API");
  const waters = await fetchWaters(cfg);
  if (waters.length === 0) {
    cfg.log.error("No water temperature available; skipping insert.");
    return []; // water-anchored: no water, no rows
  }
  const forecast = await fetchForecast(cfg); // null → water-only rows
  return waters.map((w) => buildRow(w, forecast, STORAGE_ID));
}

// Append one snapshot of the projection for later calibration of INFLATE against
// real met.no forecast error (the payload's points carry the raw forecast air/wind
// alongside our projected water, so one row records both what we predicted and the
// weather input it came from). Keyed by the hour bucket, so only the first poll of
// each hour lands and the rest are ignore-duplicate no-ops. Fail-soft, and only
// failures are logged — a "archived" line on every poll would be misleading when
// most polls are deliberate no-ops.
async function archiveForecast(cfg, payload, generatedAt) {
  const epochSec = Math.floor(generatedAt.getTime() / 1000);
  try {
    const res = await fetchWithTimeout(cfg, `${cfg.supabaseUrl}/rest/v1/forecast_archive`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseServiceKey,
        Authorization: `Bearer ${cfg.supabaseServiceKey}`,
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
      cfg.log.error(`Forecast archive failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    cfg.log.error(`Network error archiving forecast: ${err.message}`);
    return false;
  }
}

// Fetch the recent reading history for the projection (oldest-first), mapped to the
// camelCase shape lib.js expects. Paginates so the band is measured over the whole
// FIT_WINDOW_DAYS window rather than Supabase's default 1000-row read cap.
// Returns [] on any failure.
async function fetchHistory(cfg) {
  const cutoff = Math.floor(Date.now() / 1000) - FIT_WINDOW_DAYS * 86400;
  const PAGE = 1000;
  const MAX_PAGES = 50; // safety cap (50k rows ≫ any FIT_WINDOW_DAYS window)
  const rows = [];
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const url =
        `${cfg.supabaseUrl}/rest/v1/readings` +
        `?select=epoch,water,air,wind_speed,wind_dir&location_id=eq.${STORAGE_ID}` +
        `&epoch=gte.${cutoff}&order=epoch.desc&limit=${PAGE}&offset=${page * PAGE}`;
      // Newest-first so a partial fetch keeps the most recent rows; reversed below.
      const res = await fetchWithTimeout(cfg, url, {
        headers: { apikey: cfg.supabaseServiceKey, Authorization: `Bearer ${cfg.supabaseServiceKey}` },
      });
      if (!res.ok) {
        cfg.log.error(`History query failed (page ${page}, offset ${page * PAGE}): ${res.status} ${res.statusText}`);
        return [];
      }
      const batch = await res.json();
      rows.push(...batch);
      if (batch.length < PAGE) break; // last page reached
    }
    // rows are newest-first (epoch.desc); reverse to oldest-first, the order
    // persistenceError's binary search and buildProjection's seed expect.
    return rows
      .map((r) => ({ epoch: r.epoch, water: r.water, air: r.air, windSpeed: r.wind_speed, windDir: r.wind_dir }))
      .reverse();
  } catch (err) {
    cfg.log.error(`Network error fetching history: ${err.message}`);
    return [];
  }
}

// Upsert the single forecast row for this location (replace-on-write via the
// location_id primary key). Returns true on success, false on any failure.
async function upsertForecast(cfg, payload, generatedAt) {
  try {
    const res = await fetchWithTimeout(cfg, `${cfg.supabaseUrl}/rest/v1/forecast`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.supabaseServiceKey,
        Authorization: `Bearer ${cfg.supabaseServiceKey}`,
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
      cfg.log.error(`Forecast upsert failed: ${res.status} ${res.statusText}`);
      return false;
    }
    return true;
  } catch (err) {
    cfg.log.error(`Network error upserting forecast: ${err.message}`);
    return false;
  }
}

// Refresh the stored 48h projection. Independent of the water-source path: does
// its own met.no fetch, queries history, builds the projection, upserts. Fully
// fail-soft — any gap just leaves the previous forecast row in place.
async function updateForecast(cfg) {
  let json;
  try {
    const res = await fetchWithTimeout(cfg, FORECAST_API_URL, { headers: { "User-Agent": MET_USER_AGENT } });
    if (!res.ok) {
      cfg.log.error(`Forecast series request failed: ${res.status} ${res.statusText}`);
      return;
    }
    json = await res.json();
  } catch (err) {
    cfg.log.error(`Network error fetching forecast series: ${err.message}`);
    return;
  }
  try {
    const series = extractForecastSeries(json);
    if (series.length === 0) {
      cfg.log.error("No usable met.no forecast entries; skipping projection.");
      return;
    }
    const history = await fetchHistory(cfg);
    if (history.length < 2) {
      cfg.log.error("Not enough history to project; skipping projection.");
      return;
    }
    const generatedAt = new Date();
    const payload = buildProjection(history, series, { horizonH: HORIZON_H });
    const stored = await upsertForecast(cfg, payload, generatedAt);
    if (stored) {
      cfg.log.log(`Projection updated: model=${payload.model}, points=${payload.points.length}`);
    }
    await archiveForecast(cfg, payload, generatedAt); // hourly snapshot; no-op most polls
    return stored ? { model: payload.model, points: payload.points.length } : null;
  } catch (err) {
    cfg.log.error(`Projection build failed: ${err.message}`);
  }
}

// Run one poll. `config`:
//   yrApiKey, supabaseUrl, supabaseServiceKey — required secrets
//   fetch — optional fetch implementation (defaults to the global; tests inject one)
//   log   — optional console-like logger (defaults to console)
// Fail-soft like it has always been: problems are logged and the run resolves
// normally, so the next scheduled poll simply retries. Resolves to a summary
// { fetched, inserted, latest, projection } (fields null where that step didn't
// happen) for callers that want to report it.
export async function runPoll(config) {
  const cfg = {
    yrApiKey: config.yrApiKey,
    supabaseUrl: config.supabaseUrl,
    supabaseServiceKey: config.supabaseServiceKey,
    // Looked up at call time, so a fetch swapped in on globalThis is honoured.
    fetch: config.fetch ?? ((...args) => fetch(...args)),
    log: config.log ?? console,
  };
  const summary = { fetched: 0, inserted: null, latest: null, projection: null };
  if (!cfg.yrApiKey) {
    cfg.log.error("Missing YR_API_KEY.");
    return summary; // next scheduled run retries
  }
  if (!cfg.supabaseUrl || !cfg.supabaseServiceKey) {
    cfg.log.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.");
    return summary;
  }
  const rows = await pollOfficial(cfg);
  summary.fetched = rows.length;
  if (rows.length > 0) {
    const newest = rows[rows.length - 1];
    summary.latest = newest.time;
    const written = await insertRows(cfg, rows);
    if (written) {
      summary.inserted = written.length;
      cfg.log.log(
        `Fetched ${rows.length} reading(s), inserted ${written.length} new; ` +
          `latest water=${newest.water}C at ${newest.time}`,
      );
    }
  }
  // Readings are written before the projection starts, so if the projection is
  // ever cut short (a crash, or the step timeout killing a hung run) the water
  // data is already safe and only the forecast refresh is lost.
  summary.projection = (await updateForecast(cfg)) ?? null; // fail-soft; never blocks the insert
  return summary;
}
