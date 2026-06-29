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

test("degToArrow maps each cardinal/intercardinal sector to an arrow", () => {
  assert.equal(degToArrow(0), "↑");
  assert.equal(degToArrow(45), "↗");
  assert.equal(degToArrow(90), "→");
  assert.equal(degToArrow(135), "↘");
  assert.equal(degToArrow(180), "↓");
  assert.equal(degToArrow(225), "↙");
  assert.equal(degToArrow(270), "←");
  assert.equal(degToArrow(315), "↖");
});

test("degToArrow wraps around north", () => {
  assert.equal(degToArrow(360), "↑");
  assert.equal(degToArrow(359), "↑");
  assert.equal(degToArrow(338), "↑"); // 337.5 boundary rounds up to N
});

test("degToArrow rounds to the nearest sector", () => {
  assert.equal(degToArrow(22.5), "↗"); // boundary rounds up
  assert.equal(degToArrow(60), "↗");   // closer to 45 than 90
  assert.equal(degToArrow(78), "→");   // closer to 90 than 45
  assert.equal(degToArrow(237), "↙");  // the value seen in the live tooltip (SV)
});

test("degToArrow returns null for missing/invalid input", () => {
  assert.equal(degToArrow(null), null);
  assert.equal(degToArrow(undefined), null);
  assert.equal(degToArrow(NaN), null);
});

const HOUR = 3600;
const DAY = 24 * HOUR;

test("waterTrend reports a warming delta vs ~24h ago", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 15.0 },        // ~24h before newest
      { epoch: 1000 + DAY, water: 15.4 },  // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 0.4) < 1e-9);
});

test("waterTrend reports a cooling delta", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 17.0 },
      { epoch: 1000 + DAY, water: 16.0 },
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "down");
  assert.ok(Math.abs(t.delta + 1.0) < 1e-9);
});

test("waterTrend is flat when the delta rounds to zero", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 16.02 },
      { epoch: 1000 + DAY, water: 16.0 },
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "flat");
});

test("waterTrend returns null when no point is near the 24h-ago target", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 15.0 },          // 12h before newest, > 6h tolerance off the 24h target
      { epoch: 1000 + 12 * HOUR, water: 16.0 }, // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t, null);
});

test("waterTrend returns null with fewer than two usable readings", () => {
  assert.equal(waterTrend([{ epoch: 1000, water: 15 }], DAY, 6 * HOUR), null);
  assert.equal(
    waterTrend([{ epoch: 1000, water: null }, { epoch: 1000 + DAY, water: 16 }], DAY, 6 * HOUR),
    null,
  );
});

test("waterTrend accepts a candidate exactly at the tolerance boundary (strict >)", () => {
  // newest target is 24h before newest (epoch 1000); the candidate sits 6h off
  // that target, i.e. exactly toleranceSec away — must be accepted, not rejected.
  const t = waterTrend(
    [
      { epoch: 1000 + 6 * HOUR, water: 15.0 }, // 6h from the 24h-ago target
      { epoch: 1000 + DAY, water: 16.0 },      // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 1.0) < 1e-9);
});

test("waterTrend skips null-water candidates and picks the nearest usable one", () => {
  const t = waterTrend(
    [
      { epoch: 1000, water: 14.0 },           // exactly 24h ago, usable
      { epoch: 1000 + HOUR, water: null },    // closer to target but unusable
      { epoch: 1000 + DAY, water: 15.0 },     // newest
    ],
    DAY,
    6 * HOUR,
  );
  assert.equal(t.direction, "up");
  assert.ok(Math.abs(t.delta - 1.0) < 1e-9);
});
