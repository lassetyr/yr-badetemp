import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReading,
  toRow,
  extractOfficialWater,
  extractForecast,
  buildRow,
} from "../scripts/lib.js";

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

const OFFICIAL_WATER = [
  { temperature: 16, time: "2022-06-14T10:17:54+02:00" },
  { temperature: 19, time: "2021-08-13T06:17:52+02:00" },
  { temperature: 11, time: "2021-10-19T06:17:54+02:00" },
];

test("extractOfficialWater returns the newest reading regardless of array order", () => {
  assert.deepEqual(extractOfficialWater(OFFICIAL_WATER), {
    temperature: 16,
    time: "2022-06-14T10:17:54+02:00",
    epoch: Math.floor(Date.parse("2022-06-14T10:17:54+02:00") / 1000),
  });
});

test("extractOfficialWater skips entries with non-numeric temperature", () => {
  const r = extractOfficialWater([
    { temperature: null, time: "2022-06-14T10:17:54+02:00" },
    { temperature: 12, time: "2022-06-13T10:17:54+02:00" },
  ]);
  assert.equal(r.temperature, 12);
});

test("extractOfficialWater returns null for empty array, non-array, and unparseable times", () => {
  assert.equal(extractOfficialWater([]), null);
  assert.equal(extractOfficialWater(null), null);
  assert.equal(extractOfficialWater({}), null);
  assert.equal(
    extractOfficialWater([{ temperature: 12, time: "not-a-date" }]),
    null,
  );
});

const FORECAST = {
  properties: {
    timeseries: [
      {
        data: {
          instant: {
            details: {
              air_temperature: 23.5,
              wind_speed: 0.8,
              wind_speed_of_gust: 2.6,
              wind_from_direction: 78,
            },
          },
        },
      },
    ],
  },
};

test("extractForecast maps met.no instant details to camelCase", () => {
  assert.deepEqual(extractForecast(FORECAST), {
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});

test("extractForecast returns all-null fields for a malformed shape", () => {
  assert.deepEqual(extractForecast({}), {
    air: null,
    windSpeed: null,
    windGust: null,
    windDir: null,
  });
  assert.deepEqual(extractForecast(null), {
    air: null,
    windSpeed: null,
    windGust: null,
    windDir: null,
  });
});

test("extractForecast nulls individually missing fields", () => {
  const partial = {
    properties: {
      timeseries: [
        { data: { instant: { details: { air_temperature: 18 } } } },
      ],
    },
  };
  assert.deepEqual(extractForecast(partial), {
    air: 18,
    windSpeed: null,
    windGust: null,
    windDir: null,
  });
});

test("buildRow combines water and forecast into a snake_case row", () => {
  const water = { temperature: 16.6, time: "2026-06-18T18:38:27+02:00", epoch: 1781800707 };
  const forecast = { air: 23.5, windSpeed: 0.8, windGust: 2.6, windDir: 78 };
  assert.deepEqual(buildRow(water, forecast, "0-10238"), {
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

test("buildRow nulls air/wind when forecast is null (weather fetch failed)", () => {
  const water = { temperature: 16.6, time: "t", epoch: 1 };
  const row = buildRow(water, null, "0-10238");
  assert.equal(row.water, 16.6);
  assert.equal(row.air, null);
  assert.equal(row.wind_speed, null);
  assert.equal(row.wind_gust, null);
  assert.equal(row.wind_dir, null);
});
