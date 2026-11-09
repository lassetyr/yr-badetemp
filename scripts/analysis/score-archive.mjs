// Score the archived projections in forecast_archive against what the sensor
// actually measured. Unlike backtestError (which drives the model with observed
// air), this scores the forecasts as shipped, driven by the real met.no forecast.
//
//   node scripts/analysis/score-archive.mjs
//
// Prints three tables:
//   1. per horizon: MAE, bias, flat-persistence MAE, skill, band coverage, the
//      INFLATE that would hit 50/68/80/90% coverage, and met.no air MAE
//   2. per month at 12h/24h: model vs persistence bias, met.no air bias, and the
//      actual water change, separating model error from forecast-input error
//   3. per week: the fitted coupling `a` and the in-sample backtest MAE at 24h
import { INFLATE } from "../lib.js";
import { loadArchive, loadReadings, nearestReading, quantile, seedAgeS, MAX_SEED_AGE_S } from "./archive-data.mjs";

const archive = await loadArchive();
if (archive.length === 0) {
  console.log("forecast_archive is empty.");
  process.exit(0);
}
const firstSeed = archive[0].payload.points[0].epoch;
const readings = await loadReadings(firstSeed - 86400);

const usable = archive.filter((row) => row.payload?.points?.length && seedAgeS(row) <= MAX_SEED_AGE_S);
console.log(
  `snapshots: ${archive.length}, scored: ${usable.length}, skipped (stale seed): ${archive.length - usable.length}`,
);
console.log(`span: ${archive[0].generated_at} → ${archive.at(-1).generated_at}\n`);

// --- 1. per horizon -----------------------------------------------------------
const BUCKETS = [1, 3, 6, 12, 18, 24, 36, 48];
const bucketOf = (h) => {
  for (let i = 0; i < BUCKETS.length; i++) {
    const lo = (BUCKETS[i - 1] ?? 0) + 0.5;
    if (h > lo && h <= BUCKETS[i] + 0.5) return BUCKETS[i];
  }
  return null;
};
const byH = Object.fromEntries(
  BUCKETS.map((b) => [b, { n: 0, ae: 0, bias: 0, pae: 0, cov: 0, ratios: [], airAe: 0, airN: 0, days: new Set() }]),
);
for (const row of usable) {
  const [seed, ...pts] = row.payload.points;
  for (const p of pts) {
    const b = bucketOf((p.epoch - seed.epoch) / 3600);
    const obs = b && nearestReading(readings, p.epoch);
    if (!obs || obs.water == null) continue;
    const s = byH[b];
    const err = p.water - obs.water;
    const half = (p.upper - p.lower) / 2;
    s.n++;
    s.ae += Math.abs(err);
    s.bias += err;
    s.pae += Math.abs(seed.water - obs.water);
    if (Math.abs(err) <= half + 1e-9) s.cov++;
    // |err| in units of the raw (uninflated) backtest MAE: the INFLATE that would just cover it.
    if (half > 0) s.ratios.push(Math.abs(err) / (half / INFLATE));
    if (p.air != null && obs.air != null) {
      s.airAe += Math.abs(p.air - obs.air);
      s.airN++;
    }
    s.days.add(new Date(seed.epoch * 1000).toISOString().slice(0, 10));
  }
}
const f2 = (v) => v.toFixed(2);
const sgn = (v) => (v >= 0 ? "+" : "") + v.toFixed(2);
console.log(`Per horizon (°C). Band coverage at INFLATE=${INFLATE}; skill = 1 − MAE/persistence MAE.`);
console.log("h    n      days  MAE    bias   pers   skill  cover  INFLATE@50/68/80/90%      metAirMAE");
for (const b of BUCKETS) {
  const s = byH[b];
  if (!s.n) continue;
  const mae = s.ae / s.n;
  const pmae = s.pae / s.n;
  console.log(
    [
      String(b).padEnd(4),
      String(s.n).padEnd(6),
      String(s.days.size).padEnd(5),
      f2(mae).padEnd(6),
      sgn(s.bias / s.n).padEnd(6),
      f2(pmae).padEnd(6),
      `${((1 - mae / pmae) * 100).toFixed(0)}%`.padStart(5),
      `${((s.cov / s.n) * 100).toFixed(0)}%`.padStart(6),
      "",
      [0.5, 0.68, 0.8, 0.9].map((f) => f2(quantile(s.ratios, f))).join(" / ").padEnd(24),
      s.airN ? f2(s.airAe / s.airN) : "-",
    ].join(" "),
  );
}

// --- 2. per month at 12h / 24h --------------------------------------------------
const byMonth = {};
for (const row of usable) {
  const [seed, ...pts] = row.payload.points;
  const month = new Date(seed.epoch * 1000).toISOString().slice(0, 7);
  for (const p of pts) {
    const h = Math.round((p.epoch - seed.epoch) / 3600);
    if (h !== 12 && h !== 24) continue;
    const obs = nearestReading(readings, p.epoch);
    if (!obs || obs.water == null) continue;
    const s = (byMonth[`${month}  ${String(h).padStart(2)}h`] ??= { n: 0, bias: 0, pbias: 0, airB: 0, airN: 0, dWater: 0, gap: 0 });
    s.n++;
    s.bias += p.water - obs.water;
    s.pbias += seed.water - obs.water;
    s.dWater += obs.water - seed.water;
    s.gap += (seed.air ?? seed.water) - seed.water;
    if (p.air != null && obs.air != null) {
      s.airB += p.air - obs.air;
      s.airN++;
    }
  }
}
console.log("\nPer month: is the bias the model's or met.no's?");
console.log("month     h    n     modelBias  persBias  metAirBias  actualΔwater  air−water@seed");
for (const [k, s] of Object.entries(byMonth).sort()) {
  console.log(
    [
      k.padEnd(13),
      String(s.n).padEnd(5),
      sgn(s.bias / s.n).padStart(9),
      sgn(s.pbias / s.n).padStart(9),
      (s.airN ? sgn(s.airB / s.airN) : "-").padStart(11),
      sgn(s.dWater / s.n).padStart(13),
      sgn(s.gap / s.n).padStart(15),
    ].join(" "),
  );
}

// --- 3. per week: fitted coupling -------------------------------------------------
const byWeek = {};
for (const row of archive) {
  const d = new Date(row.generated_at.slice(0, 10));
  const monday = new Date(d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  (byWeek[monday] ??= []).push(row.payload);
}
console.log("\nPer week: fitted coupling a (1/h) and in-sample backtest MAE at 24h");
console.log("week of     n    mean a     backtest mae24");
const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
for (const [w, ps] of Object.entries(byWeek)) {
  const a = mean(ps.map((p) => p.coeffs?.a).filter((x) => x != null));
  const m = mean(ps.map((p) => p.backtest?.mae24).filter((x) => x != null));
  console.log(`${w}  ${String(ps.length).padEnd(4)} ${a.toExponential(2).padStart(9)}  ${f2(m).padStart(10)}`);
}
