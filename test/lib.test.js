import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReading, toRow } from "../scripts/lib.js";

const SAMPLE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: {
        locationId: "0-10238",
        timestamp: "2026-06-18T18:38:27+02:00",
        timestampEpoch: 1781800707,
        waterTemperature: 16.6,
        airTemperature: 23.5,
        windSpeed: 0.8,
        windGust: 2.6,
        windDirection: 78,
      },
    },
    {
      type: "Feature",
      properties: {
        locationId: "0-10060",
        timestamp: "2026-06-18T18:21:40+02:00",
        timestampEpoch: 1781799700,
        waterTemperature: 17.8,
      },
    },
  ],
};

test("extractReading returns canonical reading for the matching spot", () => {
  const r = extractReading(SAMPLE, "0-10238");
  assert.deepEqual(r, {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});

test("extractReading defaults missing optional fields to null", () => {
  const r = extractReading(SAMPLE, "0-10060");
  assert.equal(r.water, 17.8);
  assert.equal(r.air, null);
  assert.equal(r.windSpeed, null);
  assert.equal(r.windGust, null);
  assert.equal(r.windDir, null);
});

test("extractReading returns null when spot is absent", () => {
  assert.equal(extractReading(SAMPLE, "9-99999"), null);
});

test("extractReading returns null when geojson is malformed", () => {
  assert.equal(extractReading({}, "0-10238"), null);
  assert.equal(extractReading(null, "0-10238"), null);
});

test("toRow maps a reading to the snake_case row payload", () => {
  const reading = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  };
  assert.deepEqual(toRow(reading, "0-10238"), {
    location_id: "0-10238",
    epoch: 1781800707,
    time: "2026-06-18T18:38:27+02:00",
    water: 16.6,
    air: 23.5,
    wind_speed: 0.8,
    wind_gust: 2.6,
    wind_dir: 78,
  });
});

test("toRow preserves null optional fields", () => {
  const reading = {
    time: "t",
    epoch: 1,
    water: 17.8,
    air: null,
    windSpeed: null,
    windGust: null,
    windDir: null,
  };
  const row = toRow(reading, "0-10060");
  assert.equal(row.air, null);
  assert.equal(row.wind_speed, null);
  assert.equal(row.wind_gust, null);
  assert.equal(row.wind_dir, null);
});
