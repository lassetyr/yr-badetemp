// Pure helpers shared by the browser app and unit tests. No network/DOM here.

const RANGE_SECONDS = {
  "24h": 24 * 3600,
  "7d": 7 * 24 * 3600,
  "30d": 30 * 24 * 3600,
};

const COLUMNS = "time,epoch,water,air,wind_speed,wind_gust,wind_dir";

// Build a PostgREST query URL for one location and time range. baseUrl is the
// Supabase project URL with no trailing slash. Unknown/"all" ranges omit the
// epoch lower bound (return the full history).
export function readingsQueryUrl(baseUrl, locationId, rangeKey, nowEpoch) {
  const params = new URLSearchParams();
  params.set("select", COLUMNS);
  params.set("location_id", `eq.${locationId}`);
  params.set("order", "epoch.asc");
  if (rangeKey in RANGE_SECONDS) {
    params.set("epoch", `gte.${nowEpoch - RANGE_SECONDS[rangeKey]}`);
  }
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
