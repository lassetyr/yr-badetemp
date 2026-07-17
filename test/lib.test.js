import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractReading,
  toRow,
  extractOfficialWater,
  extractForecast,
  buildRow,
  extractForecastSeries,
  fitRelaxation,
  rollForward,
  HORIZON_H,
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

const METNO_SAMPLE = {
  properties: {
    timeseries: [
      { time: "2026-07-17T10:00:00Z", data: { instant: { details: { air_temperature: 21.0, wind_speed: 2.5 } } } },
      { time: "2026-07-17T11:00:00Z", data: { instant: { details: { air_temperature: 21.6, wind_speed: 3.1 } } } },
      { time: "2026-07-17T12:00:00Z", data: { instant: { details: {} } } }, // no air → skipped
    ],
  },
};

test("extractForecastSeries returns ascending {epoch,air,windSpeed}, skipping entries with no air", () => {
  const series = extractForecastSeries(METNO_SAMPLE);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], {
    epoch: Math.floor(Date.parse("2026-07-17T10:00:00Z") / 1000),
    air: 21.0,
    windSpeed: 2.5,
  });
  assert.equal(series[1].air, 21.6);
  assert.ok(series[0].epoch < series[1].epoch);
});

test("extractForecastSeries returns [] for a malformed response", () => {
  assert.deepEqual(extractForecastSeries({}), []);
  assert.deepEqual(extractForecastSeries(null), []);
});

// Generate readings by forward-integrating the exact relaxation model, so an
// OLS fit must recover (a,b,c) to numerical precision. dtS default = 20 min.
function synthReadings({ a, b, c, n, dtS = 1200, w0 = 15, epoch0 = 1_700_000_000 }) {
  const readings = [];
  let w = w0;
  let epoch = epoch0;
  for (let i = 0; i < n; i++) {
    const air = 20 + 5 * Math.sin(i / 10);
    const windSpeed = 2 + Math.abs(Math.sin(i / 7));
    readings.push({ epoch, water: w, air, windSpeed });
    const dtH = dtS / 3600;
    w = w + dtH * (a * (air - w) + b * windSpeed + c);
    epoch += dtS;
  }
  return readings;
}

test("fitRelaxation recovers the coefficients that generated the data", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: -0.002, n: 300 });
  const fit = fitRelaxation(r);
  assert.ok(fit.ok);
  assert.ok(Math.abs(fit.a - 0.05) < 1e-3, `a=${fit.a}`);
  assert.ok(Math.abs(fit.b - 0.01) < 1e-3, `b=${fit.b}`);
  assert.ok(Math.abs(fit.c - -0.002) < 1e-3, `c=${fit.c}`);
});

test("fitRelaxation returns ok:false below MIN_PAIRS usable pairs", () => {
  const fit = fitRelaxation(synthReadings({ a: 0.05, b: 0.01, c: 0, n: 10 }));
  assert.equal(fit.ok, false);
});

test("fitRelaxation returns ok:false on a non-physical fit (flat water → a≤0)", () => {
  // Constant water with varying air/wind: rate is 0 everywhere → a fits to ~0.
  const r = synthReadings({ a: 0, b: 0, c: 0, n: 200 });
  const fit = fitRelaxation(r);
  assert.equal(fit.ok, false);
});

test("fitRelaxation skips pairs with an out-of-range time gap", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0, n: 120 });
  r[60].epoch += 3 * 86400; // huge gap around index 60 → that pair excluded
  const fit = fitRelaxation(r);
  assert.ok(fit.ok);
  assert.ok(fit.n < r.length - 1); // at least one pair dropped
});

test("rollForward relaxes water toward the forecast air temperature", () => {
  const seed = { epoch: 1000, water: 10 };
  const hourly = Array.from({ length: 5 }, (_, i) => ({
    epoch: 1000 + (i + 1) * 3600,
    air: 20,
    windSpeed: 0,
  }));
  const pts = rollForward(seed, hourly, { a: 0.1, b: 0, c: 0 });
  assert.equal(pts.length, 5);
  // w1 = 10 + 1*(0.1*(20-10)) = 11
  assert.ok(Math.abs(pts[0].water - 11) < 1e-9);
  // monotonically rising toward 20, never overshooting
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].water > pts[i - 1].water);
  assert.ok(pts[pts.length - 1].water < 20);
});

test("rollForward stops at the horizon and ignores past/nullish entries", () => {
  const seed = { epoch: 0, water: 10 };
  const series = [
    { epoch: -3600, air: 20, windSpeed: 1 }, // before seed → ignored
    { epoch: 3600, air: 20, windSpeed: 1 },
    { epoch: 7200, air: null, windSpeed: 1 }, // null air → skipped
    { epoch: (HORIZON_H + 1) * 3600, air: 20, windSpeed: 1 }, // past horizon → excluded
  ];
  const pts = rollForward(seed, series, { a: 0.1, b: 0, c: 0 });
  assert.deepEqual(pts.map((p) => p.epoch), [3600]);
});

test("rollForward with zero coeffs is flat persistence", () => {
  const seed = { epoch: 0, water: 12.3 };
  const series = [{ epoch: 3600, air: 25, windSpeed: 5 }, { epoch: 7200, air: 5, windSpeed: 0 }];
  const pts = rollForward(seed, series, { a: 0, b: 0, c: 0 });
  assert.deepEqual(pts.map((p) => p.water), [12.3, 12.3]);
});
