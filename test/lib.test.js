import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractOfficialWaters,
  extractForecast,
  buildRow,
  extractForecastSeries,
  fitRelaxation,
  rollForward,
  backtestError,
  buildProjection,
  HORIZON_H,
  smoothAirSeries,
  SMOOTH_WINDOW_H,
  INFLATE,
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

// Generate readings by forward-integrating a relaxation model. `a` is the only
// term the fit can represent; `b` (wind) and `c` (drift) inject real effects into
// the DATA that the single-parameter model deliberately cannot chase.
// dtS default = 20 min.
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

// Readings with CONSTANT air (so 24h smoothing is an identity) and water relaxing
// toward it, generated from the exact no-intercept model. Wind varies so b is
// identifiable. Used for buildProjection tests where the smoothed driver == raw.
function synthConst({ a, b, air = 10, n, dtS = 1200, w0 = 15, epoch0 = 1_700_000_000 }) {
  const readings = [];
  let w = w0;
  let epoch = epoch0;
  for (let i = 0; i < n; i++) {
    const windSpeed = 2 + Math.abs(Math.sin(i / 7));
    readings.push({ epoch, water: w, air, windSpeed, windDir: 200 });
    const dtH = dtS / 3600;
    w = w + dtH * (a * (air - w) + b * windSpeed);
    epoch += dtS;
  }
  return readings;
}

test("fitRelaxation recovers a from pure relaxation data", () => {
  const r = synthReadings({ a: 0.05, b: 0, c: 0, n: 300 });
  const fit = fitRelaxation(r);
  assert.ok(fit.ok);
  assert.ok(Math.abs(fit.a - 0.05) < 1e-3, `a=${fit.a}`);
});

test("fitRelaxation exposes no wind or intercept coefficient", () => {
  // The model is deliberately single-parameter: an unconstrained second term is
  // what let the fitting window's mean drift ride out into the projection.
  const fit = fitRelaxation(synthReadings({ a: 0.05, b: 0.01, c: 0, n: 300 }));
  assert.equal(fit.b, undefined);
  assert.equal(fit.c, undefined);
});

test("fitRelaxation still succeeds when the data carries drift it cannot represent", () => {
  // True rate carries a +0.05/h drift with no term to absorb it; the fit must
  // stay physical (a>0) rather than contorting to chase the constant.
  const fit = fitRelaxation(synthReadings({ a: 0.05, b: 0.01, c: 0.05, n: 300 }));
  assert.equal(fit.ok, true);
  assert.ok(fit.a > 0);
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
  const pts = rollForward(seed, hourly, { a: 0.1 });
  assert.equal(pts.length, 5);
  // w1 = 10 + 1*(0.1*(20-10)) = 11
  assert.ok(Math.abs(pts[0].water - 11) < 1e-9);
  // monotonically rising toward 20, never overshooting
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].water > pts[i - 1].water);
  assert.ok(pts[pts.length - 1].water < 20);
});

test("rollForward holds water steady when air already equals it, whatever the wind", () => {
  // The regression this model change fixes. The old b*wind term drifted ~1 °C
  // over 48h here (measured against real history, 2026-09-07): wind is always
  // positive, so a negative b acted as constant cooling with no feedback to
  // pull it back. With one relaxation term, air == water is a fixed point.
  const seed = { epoch: 0, water: 17 };
  const series = Array.from({ length: 48 }, (_, i) => ({
    epoch: (i + 1) * 3600,
    air: 17,
    windSpeed: 8,
  }));
  const pts = rollForward(seed, series, { a: 0.02 });
  assert.equal(pts.length, 48);
  for (const p of pts) assert.equal(p.water, 17);
});

test("rollForward projects across forecast entries that carry no wind", () => {
  // Wind no longer drives the model, so a met.no entry missing it must not
  // truncate the projection.
  const seed = { epoch: 0, water: 10 };
  const series = [
    { epoch: 3600, air: 20, windSpeed: null },
    { epoch: 7200, air: 20 }, // field absent entirely
  ];
  const pts = rollForward(seed, series, { a: 0.1 });
  assert.deepEqual(pts.map((p) => p.epoch), [3600, 7200]);
});

test("rollForward stops at the horizon and ignores past/nullish entries", () => {
  const seed = { epoch: 0, water: 10 };
  const series = [
    { epoch: -3600, air: 20, windSpeed: 1 }, // before seed → ignored
    { epoch: 3600, air: 20, windSpeed: 1 },
    { epoch: 7200, air: null, windSpeed: 1 }, // null air → skipped
    { epoch: (HORIZON_H + 1) * 3600, air: 20, windSpeed: 1 }, // past horizon → excluded
  ];
  const pts = rollForward(seed, series, { a: 0.1 });
  assert.deepEqual(pts.map((p) => p.epoch), [3600]);
});

test("rollForward with zero coeffs is flat persistence", () => {
  const seed = { epoch: 0, water: 12.3 };
  const series = [{ epoch: 3600, air: 25, windSpeed: 5 }, { epoch: 7200, air: 5, windSpeed: 0 }];
  const pts = rollForward(seed, series, { a: 0 });
  assert.deepEqual(pts.map((p) => p.water), [12.3, 12.3]);
});

test("backtestError is small when the model reproduces the data", () => {
  // Data generated from the same single-parameter model the backtest rolls
  // forward, so any error here is integration error, not model mismatch.
  const coeffs = { a: 0.05 };
  const r = synthReadings({ a: 0.05, b: 0, c: 0, n: 600 });
  const err = backtestError(r, coeffs, [6, 12, 24]);
  for (const h of [6, 12, 24]) {
    assert.ok(err[h] != null, `err[${h}] should have samples`);
    // Small-but-nonzero: rollForward applies end-of-interval air forcing while
    // the fit uses start-of-interval predictors, so exact-model self-error is a
    // deterministic ~0.07°C — still an order of magnitude below persistence error.
    assert.ok(err[h] < 0.15, `err[${h}]=${err[h]} should be small`);
  }
});

test("backtestError with zero coeffs (persistence) has positive error on drifting water", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0.01, n: 600 });
  const err = backtestError(r, { a: 0, b: 0, c: 0 }, [24]);
  assert.ok(err[24] > 0.1, `persistence error ${err[24]} should be sizeable`);
});

test("backtestError returns null for a horizon with no samples", () => {
  const r = synthReadings({ a: 0.05, b: 0.01, c: 0, n: 20 });
  const err = backtestError(r, { a: 0.05, b: 0.01, c: 0 }, [48]);
  assert.equal(err[48], null);
});

test("buildProjection produces a relaxation payload with a bracketing band and a single coefficient", () => {
  // n=400 → ~133h of history so the 48h backtest horizon has samples (mae48 is a number).
  const history = synthConst({ a: 0.05, b: 0.01, air: 10, n: 400 });
  const seed = history[history.length - 1];
  const forecastSeries = Array.from({ length: 48 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 10,
    windSpeed: 2,
    windDir: 180,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.model, "relaxation");
  assert.ok(p.coeffs && p.coeffs.a > 0);
  assert.equal(p.coeffs.b, undefined); // wind term deleted
  assert.equal(p.coeffs.c, undefined); // intercept deleted
  assert.equal(p.horizonH, 48);
  assert.equal(p.points[0].epoch, seed.epoch); // seed first
  assert.equal(p.points[0].lower, p.points[0].upper); // zero-width band at the seed
  for (const pt of p.points) assert.ok(pt.lower <= pt.water && pt.water <= pt.upper);
  assert.equal(typeof p.backtest.mae48, "number");
});

test("buildProjection drives the roll-forward with the SMOOTHED air, damping a forecast spike", () => {
  // History air steady at 10 (24h+ of it); water relaxes to ~10. Forecast air
  // jumps to 30 instantly. The seam-smoothed driver averages the recent 10s with
  // the new 30, so the first projected step barely moves — far less than a
  // raw-instantaneous-air roll-forward with the same coeffs would.
  const history = synthConst({ a: 0.05, b: 0, air: 10, n: 100 }); // 100*20min ≈ 33h
  const seed = history[history.length - 1];
  const forecastSeries = Array.from({ length: 6 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 30,
    windSpeed: 0,
    windDir: 180,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.ok(p.coeffs && p.coeffs.a > 0);
  // Reference: roll the SAME coeffs forward on the RAW (unsmoothed) forecast air.
  const rawRoll = rollForward({ epoch: seed.epoch, water: seed.water }, forecastSeries, p.coeffs);
  const smoothedStep = Math.abs(p.points[1].water - p.points[0].water);
  const rawStep = Math.abs(rawRoll[0].water - seed.water);
  assert.ok(smoothedStep < rawStep, `smoothed step ${smoothedStep} should be < raw step ${rawStep}`);
});

test("buildProjection seam smoothing includes the history tail (not a cold start)", () => {
  // If the first forecast point's driver ignored history, its smoothed air would
  // equal the first forecast air (30). Because the 24h tail of 10s is included,
  // the effective driver is far below 30 — provable via the damped first step:
  // water must move DOWN toward ~10, not UP toward 30.
  const history = synthConst({ a: 0.05, b: 0, air: 10, n: 100 });
  const seed = history[history.length - 1]; // seed water ~10.x, below 30
  const forecastSeries = Array.from({ length: 3 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 30,
    windSpeed: 0,
    windDir: 180,
  }));
  const p = buildProjection(history, forecastSeries);
  // A cold-started (forecast-only) driver would pull water UP toward 30.
  assert.ok(p.points[1].water <= p.points[0].water + 0.1,
    `first step ${p.points[1].water} vs seed ${p.points[0].water} — tail should hold the driver near 10`);
});

test("buildProjection stores RAW forecast air/wind on points (smoothing is model-internal)", () => {
  const history = synthConst({ a: 0.05, b: 0.01, air: 10, n: 120 });
  const seed = history[history.length - 1];
  seed.windDir = 210; // last observed reading carries a bearing
  const forecastSeries = Array.from({ length: 3 }, (_, i) => ({
    epoch: seed.epoch + (i + 1) * 3600,
    air: 18 + i, // raw forecast air, varies — must appear verbatim on points
    windSpeed: 4 + i,
    windDir: 90 + i,
  }));
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.points[0].air, seed.air); // seed shows the last observed air
  assert.equal(p.points[0].windSpeed, seed.windSpeed);
  assert.equal(p.points[0].windDir, 210);
  assert.equal(p.points[1].air, 18); // first forecast point shows RAW forecast air, not smoothed
  assert.equal(p.points[1].windSpeed, 4);
  assert.equal(p.points[1].windDir, 90);
});

test("buildProjection falls back to flat persistence on a non-physical fit", () => {
  const history = synthConst({ a: 0, b: 0, air: 10, n: 120 }); // flat water → fit not ok
  const seed = history[history.length - 1];
  const forecastSeries = [
    { epoch: seed.epoch + 3600, air: 30, windSpeed: 9, windDir: 10 },
    { epoch: seed.epoch + 7200, air: 2, windSpeed: 0, windDir: 20 },
  ];
  const p = buildProjection(history, forecastSeries);
  assert.equal(p.model, "persistence");
  assert.equal(p.coeffs, null);
  assert.equal(p.points[1].water, p.points[0].water); // flat despite wild air/wind
  assert.equal(p.points[2].water, p.points[0].water);
});

test("INFLATE matches the measured band calibration", () => {
  // Walk-forward validation over 6213 readings (2026-09-07) needed 1.20-1.37x to
  // reach ~80% band coverage. Retuning this should follow a fresh measurement,
  // not a hunch — hence the assertion.
  assert.equal(INFLATE, 1.35);
});

test("smoothAirSeries replaces air with the trailing-window mean, preserving other fields", () => {
  const series = [
    { epoch: 0, air: 10, windSpeed: 1 },
    { epoch: 3600, air: 20, windSpeed: 2 },
    { epoch: 7200, air: 30, windSpeed: 3 },
  ];
  const out = smoothAirSeries(series, 2); // 2h window = 7200s, inclusive
  assert.deepEqual(out.map((e) => e.air), [10, 15, 20]);
  // i=0 → {10}; i=1 window [-3600,3600] → {10,20}=15; i=2 window [0,7200] → {10,20,30}=20
  assert.deepEqual(out.map((e) => e.windSpeed), [1, 2, 3]); // other fields preserved
  assert.equal(out[0].epoch, 0); // epoch preserved
  assert.notEqual(out, series); // new array, not mutated in place
});

test("smoothAirSeries drops entries older than the window", () => {
  const series = [
    { epoch: 0, air: 10 },
    { epoch: 3600, air: 20 },
    { epoch: 100000, air: 30 }, // far in the future — window holds only itself
  ];
  const out = smoothAirSeries(series, 2);
  assert.equal(out[2].air, 30); // 100000 window = [92800,100000]; earlier entries excluded
});

test("smoothAirSeries averages only non-null airs; empty window → null", () => {
  const series = [
    { epoch: 0, air: null },
    { epoch: 3600, air: 20 },
  ];
  const out = smoothAirSeries(series, 2);
  assert.equal(out[0].air, null); // window holds only its own null → null
  assert.equal(out[1].air, 20); // null neighbor skipped, mean of {20}
});

test("smoothAirSeries on a single element returns its own air", () => {
  assert.deepEqual(smoothAirSeries([{ epoch: 5, air: 12.5 }], 24), [{ epoch: 5, air: 12.5 }]);
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
