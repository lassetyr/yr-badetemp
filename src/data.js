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
