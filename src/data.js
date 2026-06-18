// Pure helpers shared by the browser app and unit tests.

// Parse ndjson text into an array of readings, oldest first.
export function parseNdjson(text) {
  if (!text) return [];
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// Keep readings within a time window ending at nowEpoch (seconds).
// rangeKey: "24h" | "7d" | "30d" | "all". Unknown keys return all readings.
export function filterByRange(readings, rangeKey, nowEpoch) {
  const windows = {
    "24h": 24 * 3600,
    "7d": 7 * 24 * 3600,
    "30d": 30 * 24 * 3600,
  };
  if (!(rangeKey in windows)) return readings;
  const cutoff = nowEpoch - windows[rangeKey];
  return readings.filter((r) => r.epoch >= cutoff);
}
