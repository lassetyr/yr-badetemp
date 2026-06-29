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
