// Replay model variants against two test sets and compare them with flat persistence:
//
//   archive   every non-stale forecast_archive snapshot, re-projected from the
//             history available at its seed and driven by the met.no forecast
//             air it archived, i.e. the inputs the live model really had
//   observed  a walk-forward over the whole reading history (origins every 2h),
//             driven by the air recorded in later readings, which covers the
//             seasons the archive does not (yet)
//
//   node scripts/analysis/replay-archive.mjs
//
// Variants are defined in VARIANTS below. "shipped" mirrors buildProjection in
// scripts/lib.js and is checked against the archived projections first, so a
// harness that drifts from the live model is caught before its numbers are read.
import { HORIZON_H, MIN_GAP_S, MAX_GAP_S, MIN_PAIRS } from "../lib.js";
import { loadArchive, loadReadings, lowerBound, nearestReading, seedAgeS, MAX_SEED_AGE_S } from "./archive-data.mjs";

const HORIZONS = [6, 12, 24, 48];
const DAY = 86400;

// Same semantics as lib.js smoothAirSeries (trailing mean over [t − window, t],
// nulls skipped) but O(n) with a running sum, so week-long windows stay fast.
function smooth(series, windowH) {
  const w = windowH * 3600;
  const out = new Array(series.length);
  let lo = 0;
  let sum = 0;
  let cnt = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i].air != null) {
      sum += series[i].air;
      cnt++;
    }
    while (series[lo].epoch < series[i].epoch - w) {
      if (series[lo].air != null) {
        sum -= series[lo].air;
        cnt--;
      }
      lo++;
    }
    out[i] = { epoch: series[i].epoch, water: series[i].water, air: cnt ? sum / cnt : null };
  }
  return out;
}

// Least squares of dWater/dt = a·(air − water) [+ c] over consecutive pairs,
// with the same pair filter as lib.js fitRelaxation.
function fit(rows, intercept) {
  let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const r0 = rows[i];
    const r1 = rows[i + 1];
    const gap = r1.epoch - r0.epoch;
    if (gap < MIN_GAP_S || gap > MAX_GAP_S) continue;
    if (r0.water == null || r1.water == null || r0.air == null) continue;
    const x = r0.air - r0.water;
    const y = (r1.water - r0.water) / (gap / 3600);
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  if (n < MIN_PAIRS) return null;
  if (!intercept) {
    const a = sxy / sxx;
    return a > 0 ? { a, c: 0 } : null;
  }
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const c = (sy - a * sx) / n;
  return a > 0 && Number.isFinite(c) ? { a, c } : null;
}

// Project from the last history row along `driver` ({epoch, air} ascending, after
// the seed). Returns a function h → projected water at seed + h hours (nearest step).
function project(history, driver, v) {
  const seed = history[history.length - 1];
  const from = lowerBound(history, seed.epoch - v.fitDays * DAY);
  const window = history.slice(from);
  const coeffs = fit(smooth(window, v.smoothH), v.intercept) ?? { a: 0, c: 0 };
  // Smooth across the seam, as buildProjection does, so the early driver averages
  // real observations rather than cold-starting.
  const tail = window.filter((r) => r.epoch > seed.epoch - v.smoothH * 3600);
  const combined = smooth(tail.concat(driver.map((d) => ({ epoch: d.epoch, water: null, air: d.air }))), v.smoothH);
  const steps = [];
  let w = seed.water;
  let t = seed.epoch;
  for (const d of combined) {
    if (d.epoch <= seed.epoch || d.air == null) continue;
    if (d.epoch > seed.epoch + HORIZON_H * 3600) break;
    const dt = (d.epoch - t) / 3600;
    if (dt <= 0) continue;
    w += dt * (coeffs.a * (d.air - w) + coeffs.c);
    t = d.epoch;
    steps.push({ epoch: t, water: w });
  }
  return { coeffs, at: (h) => nearestReading(steps, seed.epoch + h * 3600, 30 * 60)?.water ?? null };
}

const VARIANTS = [
  { name: "shipped (24h mean, 30d fit, no c)", smoothH: 24, fitDays: 30, intercept: false },
  { name: "intercept c, 30d fit", smoothH: 24, fitDays: 30, intercept: true },
  { name: "intercept c, 14d fit", smoothH: 24, fitDays: 14, intercept: true },
  { name: "intercept c, 7d fit", smoothH: 24, fitDays: 7, intercept: true },
  { name: "7-day mean air, 30d fit", smoothH: 168, fitDays: 30, intercept: false },
  { name: "14-day mean air, 30d fit", smoothH: 336, fitDays: 30, intercept: false },
  { name: "7-day mean air + c, 14d fit", smoothH: 168, fitDays: 14, intercept: true },
];

const readings = (await loadReadings(0)).filter((r) => r.water != null);
const archive = (await loadArchive()).filter((row) => row.payload?.points?.length && seedAgeS(row) <= MAX_SEED_AGE_S);

// --- test set 1: archived met.no forecasts --------------------------------------------
const archiveCases = archive.map((row) => {
  const [seed, ...pts] = row.payload.points;
  const history = readings.slice(0, lowerBound(readings, seed.epoch + 1));
  return {
    seed,
    history,
    driver: pts.map((p) => ({ epoch: p.epoch, air: p.air })),
    // met.no steps sit on whole hours while the seed does not, so match by nearest step.
    archived: (h) => nearestReading(pts, seed.epoch + h * 3600, 30 * 60)?.water ?? null,
  };
});

// Sanity check: the shipped variant must reproduce what the live poller archived.
{
  let n = 0, diff = 0, max = 0;
  for (const c of archiveCases) {
    const p = project(c.history, c.driver, VARIANTS[0]);
    for (const h of HORIZONS) {
      const got = p.at(h);
      const want = c.archived(h);
      if (got == null || want == null) continue;
      const d = Math.abs(Math.round(got * 10) / 10 - want);
      n++;
      diff += d;
      max = Math.max(max, d);
    }
  }
  console.log(`harness vs archived projections: mean |Δ| ${(diff / n).toFixed(3)} °C, max ${max.toFixed(2)} °C over ${n} points`);
  console.log("(small differences are expected: readings backfilled after a snapshot change its history)\n");
}

// --- test set 2: walk-forward on observed air ------------------------------------------
const observedCases = [];
for (let t = readings[0].epoch + 30 * DAY; t < readings.at(-1).epoch - HORIZON_H * 3600; t += 2 * 3600) {
  const i = lowerBound(readings, t);
  const seed = readings[i];
  if (!seed || seed.epoch - t > 1800) continue; // feed gap at the origin
  const history = readings.slice(0, i + 1);
  const driver = readings
    .slice(i + 1, lowerBound(readings, seed.epoch + HORIZON_H * 3600 + 1))
    .map((r) => ({ epoch: r.epoch, air: r.air }));
  observedCases.push({ seed, history, driver });
}

function score(cases, v) {
  const s = Object.fromEntries(HORIZONS.map((h) => [h, { n: 0, ae: 0, bias: 0, pae: 0 }]));
  for (const c of cases) {
    const p = project(c.history, c.driver, v);
    for (const h of HORIZONS) {
      const obs = nearestReading(readings, c.seed.epoch + h * 3600);
      const pred = p.at(h);
      if (!obs || pred == null) continue;
      s[h].n++;
      s[h].ae += Math.abs(pred - obs.water);
      s[h].bias += pred - obs.water;
      s[h].pae += Math.abs(c.seed.water - obs.water);
    }
  }
  return s;
}

const cell = (x) => {
  if (!x.n) return "      -       ";
  const skill = (1 - x.ae / x.pae) * 100;
  return `${(skill >= 0 ? "+" : "") + skill.toFixed(0)}% ${(x.bias >= 0 ? "+" : "") + (x.bias / x.n).toFixed(2)}`.padStart(14);
};

for (const [label, cases] of [
  [`ARCHIVE: real met.no forecast driver (${archiveCases.length} snapshots)`, archiveCases],
  [`OBSERVED: walk-forward on recorded air (${observedCases.length} origins)`, observedCases],
]) {
  console.log(label);
  console.log("skill vs persistence and bias (°C) at".padEnd(36) + HORIZONS.map((h) => `${h}h`.padStart(14)).join(""));
  for (const v of VARIANTS) {
    const s = score(cases, v);
    console.log(v.name.padEnd(36) + HORIZONS.map((h) => cell(s[h])).join(""));
  }
  console.log();
}
