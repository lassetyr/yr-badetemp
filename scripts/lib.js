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
