// Pure helpers shared by the browser app and unit tests. No network/DOM here.

const RANGE_SECONDS = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
};

// Axis bounds in milliseconds for the selected range. The right edge is always
// pinned to now so a stale feed shows an empty gap up to the current time. For
// "all" (or an unknown key) the left edge is left to ECharts (undefined).
export function rangeBounds(rangeKey, nowEpoch) {
  const max = nowEpoch * 1000;
  if (rangeKey in RANGE_SECONDS) {
    return { min: (nowEpoch - RANGE_SECONDS[rangeKey]) * 1000, max };
  }
  return { min: undefined, max };
}

const COLUMNS = "time,epoch,water,air,wind_speed,wind_gust,wind_dir";

// Build a PostgREST query URL for one location and time range. baseUrl is the
// Supabase project URL with no trailing slash. Unknown/"all" ranges omit the
// epoch lower bound (return the full history). Ordered newest-first
// (epoch.desc) so that if a row cap is ever introduced it drops the OLDEST
// rows, never the recent tail — callers reverse to oldest-first for display.
export function readingsQueryUrl(baseUrl, locationId, rangeKey, nowEpoch) {
  const params = new URLSearchParams();
  params.set("select", COLUMNS);
  params.set("location_id", `eq.${locationId}`);
  params.set("order", "epoch.desc");
  if (rangeKey in RANGE_SECONDS) {
    params.set("epoch", `gte.${nowEpoch - RANGE_SECONDS[rangeKey]}`);
  }
  return `${baseUrl}/rest/v1/readings?${params.toString()}`;
}

// Build a PostgREST query URL for the single most recent reading at a location,
// independent of any selected time range — used for the always-current header.
export function latestReadingUrl(baseUrl, locationId) {
  const params = new URLSearchParams();
  params.set("select", COLUMNS);
  params.set("location_id", `eq.${locationId}`);
  params.set("order", "epoch.desc");
  params.set("limit", "1");
  return `${baseUrl}/rest/v1/readings?${params.toString()}`;
}

// A gap larger than this between consecutive readings breaks the chart line, so
// a stale or interrupted feed reads as missing data rather than a straight line.
export const GAP_BREAK_MS = 6 * 3600 * 1000;

// Build ECharts time-axis data ([ms, value] pairs) for one series. Inserts a
// [midpoint, null] break between consecutive readings more than gapBreakMs
// apart; ECharts splits the line at the null (connectNulls stays false) and
// still draws a symbol for an isolated point left between two breaks. A null
// field value (e.g. air on a water-only row) passes through as [ms, null].
export function toSeriesPairs(readings, key, gapBreakMs = GAP_BREAK_MS) {
  const out = [];
  for (let i = 0; i < readings.length; i++) {
    const ms = readings[i].epoch * 1000;
    if (i > 0) {
      const prevMs = readings[i - 1].epoch * 1000;
      if (ms - prevMs > gapBreakMs) {
        out.push([Math.floor((prevMs + ms) / 2), null]);
      }
    }
    out.push([ms, readings[i][key] ?? null]);
  }
  return out;
}

// Map a PostgREST row (snake_case) to the camelCase reading shape the chart
// consumes.
export function mapRow(row) {
  return {
    time: row.time,
    epoch: row.epoch,
    water: row.water,
    air: row.air,
    windSpeed: row.wind_speed,
    windGust: row.wind_gust,
    windDir: row.wind_dir,
  };
}

// Min/max/mean over the non-null water values in readings, or null when there
// are none. avg is left unrounded; callers format for display.
export function waterStats(readings) {
  const values = readings.map((r) => r.water).filter((v) => v != null);
  if (values.length === 0) return null;
  let min = values[0];
  let max = values[0];
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  return { min, max, avg: sum / values.length };
}

// True when the latest reading is older than thresholdSec. Epochs in seconds.
// A missing latestEpoch is treated as not-stale (nothing to flag).
export function isStale(latestEpoch, nowEpoch, thresholdSec) {
  if (latestEpoch == null) return false;
  return nowEpoch - latestEpoch > thresholdSec;
}

// Short Norwegian age string for a duration in seconds: "12 min", "3 t", "2 d".
// Floors to the largest whole unit; negative/null collapses to "0 min".
export function humanizeAge(seconds) {
  if (seconds == null || seconds < 0) return "0 min";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(seconds / 3600);
  if (hours < 24) return `${hours} t`;
  return `${Math.floor(seconds / 86400)} d`;
}

// 8-point arrow for the direction the wind blows TOWARD, or null when the
// bearing is missing/non-finite. The input is a meteorological bearing (the
// direction the wind comes FROM, as yr.no reports it), so the arrow points the
// opposite way: a wind from the south-west (225°) blows north-east → "↗".
// Rounds to the nearest 45° sector.
const COMPASS_ARROWS = ["↑", "↗", "→", "↘", "↓", "↙", "←", "↖"];
export function degToArrow(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  const flow = (((deg + 180) % 360) + 360) % 360;
  return COMPASS_ARROWS[Math.round(flow / 45) % 8];
}

// Net water-temperature change across the supplied readings (the selected
// range): the mean of the last `sampleSize` readings minus the mean of the
// first `sampleSize`, which smooths single-point noise at either end. The two
// samples never overlap — `sampleSize` is capped at half the usable count — so
// with few readings it gracefully narrows to a plain first-vs-last comparison.
// readings are oldest-first; only non-null water values count. direction is
// "flat" when the delta rounds to 0,0. Returns null with fewer than two usable
// readings.
export function waterTrend(readings, sampleSize) {
  const usable = readings.filter((r) => r.water != null);
  if (usable.length < 2) return null;
  const n = Math.min(sampleSize, Math.floor(usable.length / 2));
  const mean = (slice) => slice.reduce((sum, r) => sum + r.water, 0) / slice.length;
  const start = mean(usable.slice(0, n));
  const end = mean(usable.slice(usable.length - n));
  const delta = end - start;
  const direction = Math.abs(delta) < 0.05 ? "flat" : delta > 0 ? "up" : "down";
  return { delta, direction };
}

// Build a PostgREST query URL for the single stored forecast row at a location.
// PostgREST returns an array; the caller reads [0]?.payload.
export function forecastQueryUrl(baseUrl, locationId) {
  const params = new URLSearchParams();
  params.set("select", "payload");
  params.set("location_id", `eq.${locationId}`);
  return `${baseUrl}/rest/v1/forecast?${params.toString()}`;
}

// Map a stored forecast payload to ECharts series data: a dashed projection
// `line`, plus a confidence band drawn as a transparent `lower` baseline and a
// stacked `band` (= upper − lower) area on top of it. Returns null when there is
// nothing to draw.
export function mapForecast(payload) {
  const points = payload?.points;
  if (!Array.isArray(points) || points.length === 0) return null;
  const line = [];
  const lower = [];
  const band = [];
  for (const p of points) {
    const ms = p.epoch * 1000;
    line.push([ms, p.water]);
    lower.push([ms, p.lower]);
    band.push([ms, p.upper - p.lower]);
  }
  return { line, lower, band };
}
