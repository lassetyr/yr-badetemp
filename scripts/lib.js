// Pure helpers for the water-temperature poller. No I/O here.

const num = (v) => (typeof v === "number" ? v : null);

// Find the feature with `locationId` and return a canonical reading,
// or null if absent or missing a numeric water temperature.
export function extractReading(geojson, locationId) {
  const features = geojson?.features;
  if (!Array.isArray(features)) return null;
  const feature = features.find((f) => f?.properties?.locationId === locationId);
  if (!feature) return null;
  const p = feature.properties;
  if (typeof p.waterTemperature !== "number") return null;
  return {
    time: p.timestamp,
    epoch: p.timestampEpoch,
    water: p.waterTemperature,
    air: num(p.airTemperature),
    windSpeed: num(p.windSpeed),
    windGust: num(p.windGust),
    windDir: num(p.windDirection),
  };
}

// Find the newest official water reading in the array and return a canonical
// shape, or null if empty/malformed. The official API returns up to 5 entries
// of { temperature, time }, newest-first, but we pick by time rather than trust
// the order.
export function extractOfficialWater(json) {
  if (!Array.isArray(json)) return null;
  let best = null;
  for (const entry of json) {
    if (typeof entry?.temperature !== "number") continue;
    const epoch = Math.floor(Date.parse(entry.time) / 1000);
    if (!Number.isFinite(epoch)) continue;
    if (!best || epoch > best.epoch) {
      best = { temperature: entry.temperature, time: entry.time, epoch };
    }
  }
  return best;
}

// Pull instant air/wind from a met.no Locationforecast 2.0 response. Returns an
// object with all-null fields if any part of the expected shape is missing.
export function extractForecast(json) {
  const details = json?.properties?.timeseries?.[0]?.data?.instant?.details;
  return {
    air: num(details?.air_temperature),
    windSpeed: num(details?.wind_speed),
    windGust: num(details?.wind_speed_of_gust),
    windDir: num(details?.wind_from_direction),
  };
}

// Combine an official water reading with an optional forecast into the
// snake_case readings row. forecast may be null when the weather fetch failed;
// the air/wind columns are nullable and the chart tolerates gaps.
export function buildRow(water, forecast, locationId) {
  return {
    location_id: locationId,
    epoch: water.epoch,
    time: water.time,
    water: water.temperature,
    air: forecast?.air ?? null,
    wind_speed: forecast?.windSpeed ?? null,
    wind_gust: forecast?.windGust ?? null,
    wind_dir: forecast?.windDir ?? null,
  };
}

// Map a reading to the snake_case row payload for the readings table.
export function toRow(reading, locationId) {
  return {
    location_id: locationId,
    epoch: reading.epoch,
    time: reading.time,
    water: reading.water,
    air: reading.air,
    wind_speed: reading.windSpeed,
    wind_gust: reading.windGust,
    wind_dir: reading.windDir,
  };
}
