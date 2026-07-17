import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readingsQueryUrl,
  latestReadingUrl,
  mapRow,
  rangeBounds,
  toSeriesPairs,
  GAP_BREAK_MS,
  waterStats,
  isStale,
  humanizeAge,
  degToArrow,
  waterTrend,
  forecastQueryUrl,
  mapForecast,
  clampForecast,
} from "../src/data.js";

const BASE = "https://proj.supabase.co";

test("readingsQueryUrl targets the readings endpoint, filters by location, orders newest-first", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "all", 1000));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/readings`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  // Newest-first so a future row cap would drop the oldest rows, not the tail.
  assert.equal(url.searchParams.get("order"), "epoch.desc");
  assert.equal(
    url.searchParams.get("select"),
    "time,epoch,water,air,wind_speed,wind_gust,wind_dir",
  );
});

test("readingsQueryUrl 'all' omits the epoch lower bound", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "all", 1000));
  assert.equal(url.searchParams.get("epoch"), null);
});

test("readingsQueryUrl unknown range omits the epoch lower bound", () => {
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "nope", 1000));
  assert.equal(url.searchParams.get("epoch"), null);
});

test("readingsQueryUrl '24h' sets epoch >= now - 24h", () => {
  const now = 1_000_000;
  const url = new URL(readingsQueryUrl(BASE, "0-10238", "24h", now));
  assert.equal(url.searchParams.get("epoch"), `gte.${now - 24 * 3600}`);
});

test("readingsQueryUrl '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  const u7 = new URL(readingsQueryUrl(BASE, "0-10238", "7d", now));
  const u30 = new URL(readingsQueryUrl(BASE, "0-10238", "30d", now));
  assert.equal(u7.searchParams.get("epoch"), `gte.${now - 7 * 24 * 3600}`);
  assert.equal(u30.searchParams.get("epoch"), `gte.${now - 30 * 24 * 3600}`);
});

test("latestReadingUrl fetches the single newest reading regardless of range", () => {
  const url = new URL(latestReadingUrl(BASE, "0-10238"));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/readings`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  assert.equal(url.searchParams.get("order"), "epoch.desc");
  assert.equal(url.searchParams.get("limit"), "1");
  // No range bound — the header must reflect the true latest reading always.
  assert.equal(url.searchParams.get("epoch"), null);
});

test("rangeBounds '24h' spans now-24h to now, in milliseconds", () => {
  const now = 1_000_000;
  assert.deepEqual(rangeBounds("24h", now), {
    min: (now - 24 * 3600) * 1000,
    max: now * 1000,
  });
});

test("rangeBounds '7d' and '30d' use correct windows", () => {
  const now = 100 * 24 * 3600;
  assert.deepEqual(rangeBounds("7d", now), {
    min: (now - 7 * 24 * 3600) * 1000,
    max: now * 1000,
  });
  assert.deepEqual(rangeBounds("30d", now), {
    min: (now - 30 * 24 * 3600) * 1000,
    max: now * 1000,
  });
});

test("rangeBounds 'all' leaves min undefined, max pinned to now", () => {
  const now = 1_000_000;
  assert.deepEqual(rangeBounds("all", now), { min: undefined, max: now * 1000 });
});

test("rangeBounds unknown range leaves min undefined", () => {
  const now = 1_000_000;
  assert.deepEqual(rangeBounds("nope", now), {
    min: undefined,
    max: now * 1000,
  });
});

test("mapRow converts snake_case columns to the camelCase reading shape", () => {
  const row = {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    wind_speed: 0.8,
    wind_gust: 2.6,
    wind_dir: 78,
  };
  assert.deepEqual(mapRow(row), {
    time: "2026-06-18T18:38:27+02:00",
    epoch: 1781800707,
    water: 16.6,
    air: 23.5,
    windSpeed: 0.8,
    windGust: 2.6,
    windDir: 78,
  });
});

test("GAP_BREAK_MS is six hours in milliseconds", () => {
  assert.equal(GAP_BREAK_MS, 6 * 3600 * 1000);
});

test("toSeriesPairs maps readings to [ms, value] pairs with no breaks within threshold", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 1200, water: 11 }, // +20 min
    { epoch: 2400, water: 12 }, // +20 min
  ];
  assert.deepEqual(toSeriesPairs(readings, "water"), [
    [0, 10],
    [1_200_000, 11],
    [2_400_000, 12],
  ]);
});

test("toSeriesPairs inserts one [midpoint, null] break for a gap over the threshold", () => {
  // 6h = 21600s. A 21601s gap exceeds the threshold; a 21600s gap does not.
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 21_601, water: 12 },
  ];
  assert.deepEqual(toSeriesPairs(readings, "water"), [
    [0, 10],
    [Math.floor((0 + 21_601_000) / 2), null],
    [21_601_000, 12],
  ]);
});

test("toSeriesPairs does not break on a gap exactly equal to the threshold", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 21_600, water: 12 }, // exactly 6h
  ];
  assert.deepEqual(toSeriesPairs(readings, "water"), [
    [0, 10],
    [21_600_000, 12],
  ]);
});

test("toSeriesPairs keeps an isolated reading (break before and after) as a pair", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 30_000, water: 11 }, // big gap before and after (>6h each)
    { epoch: 60_000, water: 12 },
  ];
  const out = toSeriesPairs(readings, "water");
  // The middle reading survives as a real pair amid the null breaks.
  assert.ok(out.some((item) => item[0] === 30_000_000 && item[1] === 11));
  // Two breaks inserted (one before, one after the middle reading).
  assert.equal(out.filter((item) => item[1] === null).length, 2);
});

test("toSeriesPairs passes through a null field value as [ms, null]", () => {
  const readings = [
    { epoch: 0, air: 20 },
    { epoch: 1200, air: null }, // water-only row: no air
  ];
  assert.deepEqual(toSeriesPairs(readings, "air"), [
    [0, 20],
    [1_200_000, null],
  ]);
});

test("toSeriesPairs respects a custom gapBreakMs", () => {
  const readings = [
    { epoch: 0, water: 10 },
    { epoch: 120, water: 11 }, // +2 min
  ];
  // 1-minute threshold → 2-min gap breaks.
  const out = toSeriesPairs(readings, "water", 60 * 1000);
  assert.equal(out.filter((item) => item[1] === null).length, 1);
});

test("waterStats returns min/max/avg over non-null water values", () => {
  const s = waterStats([
    { water: 14 }, { water: 18 }, { water: 16 },
  ]);
  assert.equal(s.min, 14);
  assert.equal(s.max, 18);
  assert.equal(s.avg, 16);
});

test("waterStats ignores null water values", () => {
  const s = waterStats([{ water: 15 }, { water: null }, { water: 17 }]);
  assert.equal(s.min, 15);
  assert.equal(s.max, 17);
  assert.equal(s.avg, 16);
});

test("waterStats returns null when no usable values", () => {
  assert.equal(waterStats([]), null);
  assert.equal(waterStats([{ water: null }, { water: null }]), null);
});

test("waterStats with a single reading gives min=max=avg", () => {
  const s = waterStats([{ water: 16.5 }]);
  assert.deepEqual(s, { min: 16.5, max: 16.5, avg: 16.5 });
});

test("isStale is false just under the threshold", () => {
  // 1h 59m old, threshold 2h
  assert.equal(isStale(1000, 1000 + 7140, 7200), false);
});

test("isStale is true past the threshold", () => {
  // 2h 1m old, threshold 2h
  assert.equal(isStale(1000, 1000 + 7260, 7200), true);
});

test("isStale is false exactly at the threshold (strict >)", () => {
  assert.equal(isStale(1000, 1000 + 7200, 7200), false);
});

test("isStale is false when latestEpoch is missing", () => {
  assert.equal(isStale(null, 99999, 7200), false);
  assert.equal(isStale(undefined, 99999, 7200), false);
});

test("humanizeAge renders minutes under an hour", () => {
  assert.equal(humanizeAge(0), "0 min");
  assert.equal(humanizeAge(59 * 60), "59 min");
});

test("humanizeAge rolls into hours at 60 minutes", () => {
  assert.equal(humanizeAge(60 * 60), "1 t");
  assert.equal(humanizeAge(23 * 3600), "23 t");
});

test("humanizeAge rolls into days at 24 hours", () => {
  assert.equal(humanizeAge(24 * 3600), "1 d");
  assert.equal(humanizeAge(3 * 86400), "3 d");
});

test("humanizeAge guards negative/null input", () => {
  assert.equal(humanizeAge(-10), "0 min");
  assert.equal(humanizeAge(null), "0 min");
});

// Input is the bearing the wind comes FROM; the arrow shows where it blows TO
// (180° opposite).
test("degToArrow points opposite the source bearing (flow direction)", () => {
  assert.equal(degToArrow(0), "↓");   // from N → blows S
  assert.equal(degToArrow(45), "↙");  // from NE → blows SW
  assert.equal(degToArrow(90), "←");  // from E → blows W
  assert.equal(degToArrow(135), "↖"); // from SE → blows NW
  assert.equal(degToArrow(180), "↑"); // from S → blows N
  assert.equal(degToArrow(225), "↗"); // from SW → blows NE
  assert.equal(degToArrow(270), "→"); // from W → blows E
  assert.equal(degToArrow(315), "↘"); // from NW → blows SE
});

test("degToArrow wraps around north", () => {
  assert.equal(degToArrow(360), "↓"); // from N → blows S
  assert.equal(degToArrow(359), "↓");
  assert.equal(degToArrow(338), "↓"); // ≈ from N → blows S
});

test("degToArrow rounds to the nearest sector", () => {
  assert.equal(degToArrow(22.5), "↙"); // boundary rounds up
  assert.equal(degToArrow(60), "↙");   // from ~NE → blows SW
  assert.equal(degToArrow(78), "←");   // from ~E → blows W
  assert.equal(degToArrow(237), "↗");  // the value seen in the live tooltip (from SW → blows NE)
});

test("degToArrow returns null for missing/invalid input", () => {
  assert.equal(degToArrow(null), null);
  assert.equal(degToArrow(undefined), null);
  assert.equal(degToArrow(NaN), null);
});

// waterTrend(readings, sampleSize): net change across the (oldest-first) range,
// mean of the last `sampleSize` readings minus the mean of the first.
test("waterTrend reports a warming delta over the period (smoothed ends)", () => {
  // first-2 mean = 11, last-2 mean = 17 → +6
  const t = waterTrend(
    [{ water: 10 }, { water: 12 }, { water: 16 }, { water: 18 }],
    2,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 6) < 1e-9);
});

test("waterTrend reports a cooling delta", () => {
  // first-2 mean = 17, last-2 mean = 11 → -6
  const t = waterTrend(
    [{ water: 18 }, { water: 16 }, { water: 12 }, { water: 10 }],
    2,
  );
  assert.equal(t.direction, "down");
  assert.ok(Math.abs(t.delta + 6) < 1e-9);
});

test("waterTrend smoothing dampens a single end spike", () => {
  // last-2 mean = (16+20)/2 = 18 vs first-2 mean = 16 → +2 (a raw last-vs-first
  // would have read +4 off the 20° spike)
  const t = waterTrend(
    [{ water: 16 }, { water: 16 }, { water: 16 }, { water: 20 }],
    2,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 2) < 1e-9);
});

test("waterTrend is flat when the smoothed delta rounds to zero", () => {
  // first-2 mean = 16.02, last-2 mean = 15.99 → -0.03 → flat
  const t = waterTrend(
    [{ water: 16.0 }, { water: 16.04 }, { water: 15.98 }, { water: 16.0 }],
    2,
  );
  assert.equal(t.direction, "flat");
});

test("waterTrend caps the sample at half the readings (no overlap)", () => {
  // only 2 usable → sample narrows to 1 each end → plain first-vs-last
  const t = waterTrend([{ water: 14 }, { water: 15 }], 3);
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 1) < 1e-9);
});

test("waterTrend skips null-water readings", () => {
  // usable = [10, 14]; sample narrows to 1 each end → +4
  const t = waterTrend(
    [{ water: 10 }, { water: null }, { water: 14 }],
    1,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 4) < 1e-9);
});

test("waterTrend returns null with fewer than two usable readings", () => {
  assert.equal(waterTrend([], 3), null);
  assert.equal(waterTrend([{ water: 15 }], 3), null);
  assert.equal(waterTrend([{ water: null }, { water: 16 }], 3), null);
});

test("forecastQueryUrl targets the forecast endpoint and filters by location", () => {
  const url = new URL(forecastQueryUrl(BASE, "0-10238"));
  assert.equal(url.origin + url.pathname, `${BASE}/rest/v1/forecast`);
  assert.equal(url.searchParams.get("location_id"), "eq.0-10238");
  assert.equal(url.searchParams.get("select"), "payload,generated_at");
});

test("mapForecast builds line + stacked band pairs from points", () => {
  const payload = {
    points: [
      { epoch: 1000, water: 15, lower: 15, upper: 15 },
      { epoch: 4600, water: 15.4, lower: 14.9, upper: 15.9 },
    ],
  };
  const m = mapForecast(payload);
  assert.deepEqual(m.line, [[1_000_000, 15], [4_600_000, 15.4]]);
  assert.deepEqual(m.lower, [[1_000_000, 15], [4_600_000, 14.9]]);
  // band = upper - lower, stacked on top of `lower`. Compare ms + tolerance
  // (15.9 - 14.9 is 1.0000000000000009 in float, so avoid exact equality).
  assert.equal(m.band[0][0], 1_000_000);
  assert.equal(m.band[0][1], 0);
  assert.equal(m.band[1][0], 4_600_000);
  assert.ok(Math.abs(m.band[1][1] - 1.0) < 1e-9);
});

test("mapForecast returns null for missing or empty payloads", () => {
  assert.equal(mapForecast(null), null);
  assert.equal(mapForecast({}), null);
  assert.equal(mapForecast({ points: [] }), null);
});

// Forecast as mapForecast emits it: line/lower/band share timestamps. Points at
// now, +6h, +12h, +24h, +48h (nowEpochSec = 1000 → ms = epoch*1000).
const FC_NOW = 1000;
const FC = {
  line:  [[1_000_000, 20], [22_600_000, 20.2], [44_200_000, 20.4], [87_400_000, 20.1], [173_800_000, 19.5]],
  lower: [[1_000_000, 20], [22_600_000, 19.9], [44_200_000, 19.8], [87_400_000, 19.3], [173_800_000, 18.5]],
  band:  [[1_000_000, 0],  [22_600_000, 0.6],  [44_200_000, 1.2],  [87_400_000, 1.6],  [173_800_000, 2.0]],
};

test("clampForecast keeps points within the horizon, drops those beyond, retains the seed", () => {
  const c = clampForecast(FC, FC_NOW, 12); // cutoff = (1000 + 12*3600)*1000 = 44_200_000
  assert.equal(c.line.length, 3);          // now, +6h, +12h (== cutoff, inclusive)
  assert.deepEqual(c.line[0], [1_000_000, 20]);           // seed retained
  assert.equal(c.line[c.line.length - 1][0], 44_200_000); // last drawn point at +12h
  // line/lower/band clamped to the SAME timestamps
  assert.deepEqual(c.lower.map((p) => p[0]), c.line.map((p) => p[0]));
  assert.deepEqual(c.band.map((p) => p[0]), c.line.map((p) => p[0]));
});

test("clampForecast at the full 48h horizon keeps every point", () => {
  const c = clampForecast(FC, FC_NOW, 48);
  assert.equal(c.line.length, 5);
});

test("clampForecast returns null for a null or empty forecast", () => {
  assert.equal(clampForecast(null, FC_NOW, 12), null);
  assert.equal(clampForecast({ line: [], lower: [], band: [] }, FC_NOW, 12), null);
});

test("clampForecast returns null when nothing is within the horizon", () => {
  // A forecast whose only point is +24h, viewed with a 12h horizon → all dropped.
  const late = { line: [[87_400_000, 20]], lower: [[87_400_000, 19]], band: [[87_400_000, 1]] };
  assert.equal(clampForecast(late, FC_NOW, 12), null);
});
