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

// Return the last reading from ndjson text, or null if there are no lines.
export function parseLastReading(text) {
  if (!text) return null;
  const lines = text.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;
  return JSON.parse(lines[lines.length - 1]);
}

// Append only when the fetched reading is strictly newer than the stored one.
export function shouldAppend(lastReading, reading) {
  if (!reading) return false;
  if (!lastReading) return true;
  return reading.epoch > lastReading.epoch;
}

// Serialize a reading to a single ndjson line (no trailing newline).
export function formatLine(reading) {
  return JSON.stringify({
    time: reading.time,
    epoch: reading.epoch,
    water: reading.water,
    air: reading.air,
    windSpeed: reading.windSpeed,
    windGust: reading.windGust,
    windDir: reading.windDir,
  });
}
