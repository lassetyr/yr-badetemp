// Pure helpers for the water-temperature poller. No I/O here.

const num = (v) => (typeof v === "number" ? v : null);

// --- Forecast tunables -------------------------------------------------------
export const FIT_WINDOW_DAYS = 30;   // history window the band is measured over
export const HORIZON_H = 48;         // projection horizon (hours)
export const BAND_QUANTILE = 0.8;    // band covers this share of past persistence errors
export const BAND_HORIZONS = [6, 12, 24, 48];
export const BAND_STRIDE = 6;        // subsample band origins (~hourly at 10-min cadence)
export const FALLBACK_ERR = 0.5;     // band half-width (°C) when history cannot measure it

// Canonicalise every official water reading in the response, oldest-first.
// The endpoint serves the five most recent registrations for the location
// (documented, and confirmed against the saved help article), so keeping only
// the newest threw away most of what each poll already fetched: the sensor
// reports roughly every 10 minutes while the poll runs less often, which cost
// ~40% of the sensor's data. Inserting all of them backfills those gaps and
// makes the poll interval independent of completeness, up to the ~50 minutes
// five readings span. Entries with a non-numeric temperature or unparseable
// time are skipped; duplicate timestamps collapse. Returns [] when there is
// nothing usable.
export function extractOfficialWaters(json) {
  if (!Array.isArray(json)) return [];
  const byEpoch = new Map();
  for (const entry of json) {
    if (typeof entry?.temperature !== "number") continue;
    const epoch = Math.floor(Date.parse(entry.time) / 1000);
    if (!Number.isFinite(epoch)) continue;
    if (!byEpoch.has(epoch)) {
      byEpoch.set(epoch, { temperature: entry.temperature, time: entry.time, epoch });
    }
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

// Pull instant air/wind from a met.no Locationforecast 2.0 response. Returns an
// object with all-null fields if any part of the expected shape is missing.
export function extractForecast(json) {
  const details = json?.properties?.timeseries?.[0]?.data?.instant?.details;
  return {
    air: num(details?.air_temperature),
    windSpeed: num(details?.wind_speed),
    windGust: num(details?.wind_speed_of_gust),
    windDir: num(details?.wind_from_direction),
  };
}

// Combine an official water reading with an optional forecast into the
// snake_case readings row. forecast may be null when the weather fetch failed;
// the air/wind columns are nullable and the chart tolerates gaps.
export function buildRow(water, forecast, locationId) {
  return {
    location_id: locationId,
    epoch: water.epoch,
    time: water.time,
    water: water.temperature,
    air: forecast?.air ?? null,
    wind_speed: forecast?.windSpeed ?? null,
    wind_gust: forecast?.windGust ?? null,
    wind_dir: forecast?.windDir ?? null,
  };
}

// Pull the forward air/wind timeseries from a met.no Locationforecast 2.0
// response, as ascending {epoch, air, windSpeed, windDir}. Entries without a numeric
// air_temperature are skipped (the air forecast line is what they are for); windSpeed
// and windDir fall back to null. Unlike extractForecast (which keeps only hour 0), this
// returns every entry — buildProjection bounds it to the horizon.
export function extractForecastSeries(json) {
  const series = json?.properties?.timeseries;
  if (!Array.isArray(series)) return [];
  const out = [];
  for (const entry of series) {
    const details = entry?.data?.instant?.details;
    const air = num(details?.air_temperature);
    if (air == null) continue;
    const epoch = Math.floor(Date.parse(entry.time) / 1000);
    if (!Number.isFinite(epoch)) continue;
    out.push({ epoch, air, windSpeed: num(details?.wind_speed), windDir: num(details?.wind_from_direction) });
  }
  return out;
}

// Floor an epoch (seconds) to the top of its hour. Used as the archive's
// primary key so the first poll of each hour inserts and the rest collide into
// ignore-duplicate no-ops — the same idempotence trick the readings PK uses,
// which is what throttles ~93 daily polls down to one archived snapshot an hour.
export function hourBucket(epochSec) {
  return Math.floor(epochSec / 3600) * 3600;
}

// Index of the first entry with epoch >= t in an epoch-ascending array;
// arr.length when there is none.
function lowerBound(arr, t) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid].epoch < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Nearest entry to `t` (seconds) within `tolS` in an epoch-ascending array; on
// a tie the earlier entry wins. Binary search keeps persistenceError near-linear
// in history size (the projection is the only CPU-heavy step of a poll).
function nearestByEpoch(arr, t, tolS) {
  const i = lowerBound(arr, t);
  const before = i > 0 ? arr[i - 1] : null;
  const after = i < arr.length ? arr[i] : null;
  let best = before;
  if (after && (!before || after.epoch - t < t - before.epoch)) best = after;
  return best && Math.abs(best.epoch - t) <= tolS ? best : null;
}

// Value at fraction q of the sorted copy of `values`.
function quantile(values, q) {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

// How far the water actually moved over each horizon in `readings`: the `q`
// quantile of |water(t + h) − water(t)| over strided origins t. This is exactly
// the error a flat projection would have made, measured on real outcomes, so a
// band of this half-width covers about `q` of them with no inflation factor.
// Returns {h: °C | null}, null where no origin has a reading h hours later.
export function persistenceError(readings, horizonsH = BAND_HORIZONS, q = BAND_QUANTILE, opts = {}) {
  const stride = opts.stride ?? BAND_STRIDE;
  const tolS = opts.toleranceS ?? 1800;
  const sorted = readings.every((r, i) => i === 0 || readings[i - 1].epoch <= r.epoch)
    ? readings
    : [...readings].sort((a, b) => a.epoch - b.epoch);
  const out = {};
  for (const h of horizonsH) {
    const errors = [];
    for (let i = 0; i < sorted.length; i += stride) {
      const origin = sorted[i];
      if (origin.water == null) continue;
      const later = nearestByEpoch(sorted, origin.epoch + h * 3600, tolS);
      if (later?.water == null) continue;
      errors.push(Math.abs(later.water - origin.water));
    }
    out[h] = errors.length > 0 ? quantile(errors, q) : null;
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;

// Linear-interpolate the per-horizon band half-width at hour h, clamped to the
// measured endpoints; falls back to FALLBACK_ERR when no horizon has samples.
function interpError(err, h) {
  const pts = BAND_HORIZONS.filter((k) => err[k] != null).map((k) => [k, err[k]]);
  if (pts.length === 0) return FALLBACK_ERR;
  if (h <= pts[0][0]) return pts[0][1];
  if (h >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (h <= pts[i][0]) {
      const [h0, e0] = pts[i - 1];
      const [h1, e1] = pts[i];
      return e0 + ((e1 - e0) * (h - h0)) / (h1 - h0);
    }
  }
  return pts[pts.length - 1][1];
}

// Assemble the stored forecast payload: a FLAT water projection at the last
// measured value, one point per met.no forecast step within the horizon, wrapped
// in a band sized by persistenceError. points[0] is the seed with a zero-width
// band so the dashed line joins the solid line at "now". Each point carries the
// raw met.no air/wind, which the chart draws as the air and wind forecast lines.
//
// Why flat: the relaxation model it replaced (dWater/dt = a·(air − water)) lost
// to persistence on the archived met.no forecasts (Sep–Nov 2026). Water does not
// settle at air temperature but at a seasonal offset from it (−1.9 °C in June,
// +3.8 °C in November) because the fjord lags the season. Fitting that offset
// removed the bias but made every horizon worse, and no variant replayed by
// scripts/analysis/replay-archive.mjs beat a flat line on both test sets. Prove
// a new model there before adding one back.
export function buildProjection(history, forecastSeries, opts = {}) {
  const horizonH = opts.horizonH ?? HORIZON_H;
  const seed = history.reduce((a, b) => (b.epoch > a.epoch ? b : a));
  const water = round1(seed.water);
  const err = persistenceError(history, BAND_HORIZONS, BAND_QUANTILE);
  const points = [{
    epoch: seed.epoch,
    water,
    lower: water,
    upper: water,
    air: seed.air ?? null,
    windSpeed: seed.windSpeed ?? null,
    windDir: seed.windDir ?? null,
  }];
  const cutoff = seed.epoch + horizonH * 3600;
  for (const f of forecastSeries) {
    if (f.epoch <= seed.epoch) continue;
    if (f.epoch > cutoff) break;
    const e = interpError(err, (f.epoch - seed.epoch) / 3600);
    points.push({
      epoch: f.epoch,
      water,
      lower: round1(seed.water - e),
      upper: round1(seed.water + e),
      air: f.air ?? null,
      windSpeed: f.windSpeed ?? null,
      windDir: f.windDir ?? null,
    });
  }
  return {
    horizonH,
    model: "persistence",
    coeffs: null,
    bandQuantile: BAND_QUANTILE,
    persistenceError: err,
    points,
  };
}
