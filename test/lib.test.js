import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractOfficialWaters,
  extractForecast,
  buildRow,
  extractForecastSeries,
  persistenceError,
  buildProjection,
  BAND_QUANTILE,
  FALLBACK_ERR,
  hourBucket,
} from "../scripts/lib.js";

const OFFICIAL_WATER = [
  { temperature: 16, time: "2022-06-14T10:17:54+02:00" },
  { temperature: 19, time: "2021-08-13T06:17:52+02:00" },
  { temperature: 11, time: "2021-10-19T06:17:54+02:00" },
];

test("extractOfficialWaters returns every reading, oldest-first", () => {
  // The official endpoint serves the five most recent registrations. Keeping only
  // the newest discarded ~40% of the sensor's data, because the sensor reports
  // roughly every 10 min while we poll less often (measured 2026-09-07).
  const all = extractOfficialWaters(OFFICIAL_WATER);
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((r) => r.temperature), [19, 11, 16]); // ascending by time
  assert.deepEqual(all[2], {
    temperature: 16,
    time: "2022-06-14T10:17:54+02:00",
    epoch: Math.floor(Date.parse("2022-06-14T10:17:54+02:00") / 1000),
  });
});

test("extractOfficialWaters skips entries with non-numeric temperature", () => {
  const all = extractOfficialWaters([
    { temperature: null, time: "2022-06-14T10:17:54+02:00" },
    { temperature: 12, time: "2022-06-13T10:17:54+02:00" },
  ]);
  assert.deepEqual(all.map((r) => r.temperature), [12]);
});

test("extractOfficialWaters returns [] for empty, non-array, and unparseable input", () => {
  assert.deepEqual(extractOfficialWaters([]), []);
  assert.deepEqual(extractOfficialWaters(null), []);
  assert.deepEqual(extractOfficialWaters({}), []);
  assert.deepEqual(extractOfficialWaters([{ temperature: 12, time: "not-a-date" }]), []);
});

test("extractOfficialWaters de-duplicates repeated timestamps", () => {
  // Consecutive polls overlap heavily; the DB primary key already makes that a
  // no-op, but one response should not carry the same epoch twice.
  const all = extractOfficialWaters([
    { temperature: 16, time: "2022-06-14T10:17:54+02:00" },
    { temperature: 16, time: "2022-06-14T10:17:54+02:00" },
  ]);
  assert.equal(all.length, 1);
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
      { time: "2026-07-17T10:00:00Z", data: { instant: { details: { air_temperature: 21.0, wind_speed: 2.5, wind_from_direction: 180 } } } },
      { time: "2026-07-17T11:00:00Z", data: { instant: { details: { air_temperature: 21.6, wind_speed: 3.1 } } } }, // no direction → windDir null
      { time: "2026-07-17T12:00:00Z", data: { instant: { details: {} } } }, // no air → skipped
    ],
  },
};

test("extractForecastSeries returns ascending {epoch,air,windSpeed,windDir}, skipping entries with no air", () => {
  const series = extractForecastSeries(METNO_SAMPLE);
  assert.equal(series.length, 2);
  assert.deepEqual(series[0], {
    epoch: Math.floor(Date.parse("2026-07-17T10:00:00Z") / 1000),
    air: 21.0,
    windSpeed: 2.5,
    windDir: 180,
  });
  assert.equal(series[1].air, 21.6);
  assert.equal(series[1].windDir, null); // absent wind_from_direction → null
  assert.ok(series[0].epoch < series[1].epoch);
});

test("extractForecastSeries returns [] for a malformed response", () => {
  assert.deepEqual(extractForecastSeries({}), []);
  assert.deepEqual(extractForecastSeries(null), []);
});

// Hourly readings whose water follows `waterAt(hourIndex)`, with raw air/wind.
function hourly(n, waterAt, epoch0 = 1_700_000_000) {
  return Array.from({ length: n }, (_, i) => ({
    epoch: epoch0 + i * 3600,
    water: waterAt(i),
    air: 12,
    windSpeed: 3,
    windDir: 200,
  }));
}

// Hourly met.no-shaped forecast entries after `seed`.
function forecastAfter(seed, n, air = () => 10) {
  return Array.from({ length: n }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: air(i),
    windSpeed: 2,
    windDir: 180,
  }));
}

test("persistenceError is the change in water over each horizon on steady drift", () => {
  // Water rises 0.1 °C every hour, so after h hours it has always moved 0.1·h.
  const r = hourly(24 * 10, (i) => 10 + 0.1 * i);
  const err = persistenceError(r, [6, 12]);
  assert.ok(Math.abs(err[6] - 0.6) < 1e-9, `err[6]=${err[6]}`);
  assert.ok(Math.abs(err[12] - 1.2) < 1e-9, `err[12]=${err[12]}`);
});

test("persistenceError takes the requested quantile of the absolute change", () => {
  // Water alternates between 10 and 11 every 6 hours, so a 6h change is always
  // exactly 1 °C in size (half up, half down): every quantile is 1.
  const r = hourly(24 * 10, (i) => (Math.floor(i / 6) % 2 ? 11 : 10));
  assert.ok(Math.abs(persistenceError(r, [6], 0.8)[6] - 1) < 1e-9);
  // Mixed sizes: the 0.9 quantile cannot be below the 0.5 quantile.
  const wobbly = hourly(24 * 10, (i) => 10 + Math.sin(i / 5) + 0.3 * Math.sin(i / 2));
  const lo = persistenceError(wobbly, [12], 0.5)[12];
  const hi = persistenceError(wobbly, [12], 0.9)[12];
  assert.ok(lo < hi, `q50 ${lo} should be below q90 ${hi}`);
});

test("persistenceError returns null for a horizon with no samples", () => {
  const r = hourly(10, (i) => 10 + 0.1 * i); // 9h of history
  assert.equal(persistenceError(r, [48])[48], null);
});

test("persistenceError gives the same answer for unsorted input", () => {
  const r = hourly(24 * 5, (i) => 10 + Math.sin(i / 7));
  const shuffled = [...r].reverse();
  assert.deepEqual(persistenceError(shuffled, [6, 24]), persistenceError(r, [6, 24]));
});

test("buildProjection is flat persistence: every point holds the last measured water", () => {
  // Replay of archived met.no forecasts (2026-11-09) found no air-driven model
  // that beats a flat line on both test sets, so the projection no longer moves.
  const history = hourly(24 * 5, (i) => 10 + 0.05 * i);
  const seed = history[history.length - 1];
  const p = buildProjection(history, forecastAfter(seed, 48, (i) => 30 - i)); // wild air must not matter
  assert.equal(p.model, "persistence");
  assert.equal(p.coeffs, null);
  assert.equal(p.horizonH, 48);
  assert.equal(p.points[0].epoch, seed.epoch);
  for (const pt of p.points) assert.equal(pt.water, Math.round(seed.water * 10) / 10);
});

test("buildProjection sizes the band from the persistence-error quantile and widens it with horizon", () => {
  const history = hourly(24 * 10, (i) => 10 + 0.1 * i); // |change| over h hours = 0.1·h exactly
  const seed = history[history.length - 1];
  const p = buildProjection(history, forecastAfter(seed, 48));
  assert.equal(p.bandQuantile, BAND_QUANTILE);
  assert.equal(p.points[0].lower, p.points[0].upper); // zero-width at the seed
  const at = (h) => p.points.find((pt) => pt.epoch === seed.epoch + h * 3600);
  const half = (pt) => Math.round(((pt.upper - pt.lower) / 2) * 10) / 10;
  assert.equal(half(at(6)), 0.6);
  assert.equal(half(at(12)), 1.2);
  assert.ok(half(at(48)) > half(at(24)), "band should widen with horizon");
  for (const pt of p.points) assert.ok(pt.lower <= pt.water && pt.water <= pt.upper);
});

test("buildProjection falls back to FALLBACK_ERR when history is too short to measure", () => {
  const history = hourly(3, () => 10);
  const seed = history[history.length - 1];
  const p = buildProjection(history, forecastAfter(seed, 6));
  assert.equal(p.points[1].upper - p.points[1].water, FALLBACK_ERR);
});

test("buildProjection stops at the horizon and keeps forecast steps that lack air", () => {
  const history = hourly(24 * 3, () => 10);
  const seed = history[history.length - 1];
  const series = forecastAfter(seed, 60);
  series[2].air = null; // water no longer depends on air, so the step still projects
  const p = buildProjection(history, series, { horizonH: 48 });
  assert.equal(p.points.length, 1 + 48);
  assert.equal(p.points[3].air, null);
  assert.equal(p.points.at(-1).epoch, seed.epoch + 48 * 3600);
});

test("buildProjection stores RAW forecast air/wind on points", () => {
  const history = hourly(24 * 3, () => 10);
  const seed = history[history.length - 1];
  seed.windDir = 210; // last observed reading carries a bearing
  const series = forecastAfter(seed, 3, (i) => 18 + i).map((f, i) => ({ ...f, windSpeed: 4 + i, windDir: 90 + i }));
  const p = buildProjection(history, series);
  assert.equal(p.points[0].air, seed.air); // seed shows the last observed air
  assert.equal(p.points[0].windDir, 210);
  assert.equal(p.points[1].air, 18);
  assert.equal(p.points[1].windSpeed, 4);
  assert.equal(p.points[1].windDir, 90);
});

test("BAND_QUANTILE matches the measured calibration", () => {
  // A trailing 30-day 0.8 quantile covered 81-85% of real 6-48h outcomes it was
  // not computed from (walk-forward over Jun-Nov 2026). Retune only after a fresh
  // measurement (scripts/analysis/score-archive.mjs), not a hunch.
  assert.equal(BAND_QUANTILE, 0.8);
});

test("hourBucket floors an epoch to the top of its hour", () => {
  assert.equal(hourBucket(1788777195), 1788775200); // 10:33:15Z -> 10:00:00Z
  assert.equal(hourBucket(1788775200), 1788775200); // already on the hour
});

test("hourBucket collapses every poll within an hour to one key", () => {
  // This is what throttles the archive to hourly: the bucket is the primary key,
  // so the first poll of the hour inserts and the rest are ignore-duplicate
  // no-ops. Without this, all ~93 daily polls would be archived.
  const base = 1788775200;
  const polls = [base, base + 600, base + 1800, base + 3599].map(hourBucket);
  assert.deepEqual(polls, [base, base, base, base]);
  assert.equal(hourBucket(base + 3600), base + 3600); // next hour is a new key
});
