// Pure helpers for the water-temperature poller. No I/O here.

const num = (v) => (typeof v === "number" ? v : null);

// --- Forecast model tunables ------------------------------------------------
export const FIT_WINDOW_DAYS = 30;   // history window queried for the fit
export const MIN_GAP_S = 300;        // ignore consecutive pairs closer than 5 min
export const MAX_GAP_S = 5400;       // ...or farther apart than 90 min (feed gaps)
export const MIN_PAIRS = 50;         // min usable pairs before the fit is trusted
export const HORIZON_H = 48;         // projection horizon (hours)
export const INFLATE = 1.3;          // band inflation for met.no forecast-input error
export const BACKTEST_HORIZONS = [6, 12, 24, 48];
export const BACKTEST_STRIDE = 6;    // subsample origins ~every 2h at 20-min cadence
export const FALLBACK_ERR = 0.5;     // band half-width (°C) when backtest has no data

// Find the feature with `locationId` and return a canonical reading,
// or null if absent or missing a numeric water temperature.
export function extractReading(geojson, locationId) {
  const features = geojson?.features;
  if (!Array.isArray(features)) return null;
  const feature = features.find((f) => f?.properties?.locationId === locationId);
  if (!feature) return null;
  const p = feature.properties;
  if (typeof p.waterTemperature !== "number") return null;
  return {
    time: p.timestamp,
    epoch: p.timestampEpoch,
    water: p.waterTemperature,
    air: num(p.airTemperature),
    windSpeed: num(p.windSpeed),
    windGust: num(p.windGust),
    windDir: num(p.windDirection),
  };
}

// Find the newest official water reading in the array and return a canonical
// shape, or null if empty/malformed. The official API returns up to 5 entries
// of { temperature, time }, newest-first, but we pick by time rather than trust
// the order.
export function extractOfficialWater(json) {
  if (!Array.isArray(json)) return null;
  let best = null;
  for (const entry of json) {
    if (typeof entry?.temperature !== "number") continue;
    const epoch = Math.floor(Date.parse(entry.time) / 1000);
    if (!Number.isFinite(epoch)) continue;
    if (!best || epoch > best.epoch) {
      best = { temperature: entry.temperature, time: entry.time, epoch };
    }
  }
  return best;
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

// Map a reading to the snake_case row payload for the readings table.
export function toRow(reading, locationId) {
  return {
    location_id: locationId,
    epoch: reading.epoch,
    time: reading.time,
    water: reading.water,
    air: reading.air,
    wind_speed: reading.windSpeed,
    wind_gust: reading.windGust,
    wind_dir: reading.windDir,
  };
}

// Pull the forward air/wind timeseries from a met.no Locationforecast 2.0
// response, as ascending {epoch, air, windSpeed}. Entries without a numeric
// air_temperature are skipped (they can't drive the relaxation model); windSpeed
// falls back to null. Unlike extractForecast (which keeps only hour 0), this
// returns every entry — the projection roll-forward bounds it to the horizon.
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
    out.push({ epoch, air, windSpeed: num(details?.wind_speed) });
  }
  return out;
}

// 3x3 determinant.
function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  );
}

// Solve Ax = y for a 3x3 A by Cramer's rule. Returns [x0,x1,x2] or null when the
// system is singular/near-singular.
function solve3(A, y) {
  const d = det3(A);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) return null;
  const withCol = (j) => A.map((row, i) => row.map((v, k) => (k === j ? y[i] : v)));
  return [det3(withCol(0)) / d, det3(withCol(1)) / d, det3(withCol(2)) / d];
}

// Least-squares fit of dWater/dt = a*(air-water) + b*windSpeed + c over
// consecutive reading pairs. Only pairs with a sane time gap and all predictors
// present contribute. Returns {a,b,c,n,ok}; ok gates the caller into the
// persistence fallback when the fit is untrustworthy or non-physical (a<=0).
export function fitRelaxation(readings, opts = {}) {
  const minGap = opts.minGapS ?? MIN_GAP_S;
  const maxGap = opts.maxGapS ?? MAX_GAP_S;
  const minPairs = opts.minPairs ?? MIN_PAIRS;
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhs = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < readings.length - 1; i++) {
    const r0 = readings[i];
    const r1 = readings[i + 1];
    const gap = r1.epoch - r0.epoch;
    if (gap < minGap || gap > maxGap) continue;
    if (r0.water == null || r1.water == null || r0.air == null || r0.windSpeed == null) continue;
    const dtH = gap / 3600;
    const rate = (r1.water - r0.water) / dtH;
    const x = [r0.air - r0.water, r0.windSpeed, 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) S[a][b] += x[a] * x[b];
      rhs[a] += x[a] * rate;
    }
    n++;
  }
  if (n < minPairs) return { a: 0, b: 0, c: 0, n, ok: false };
  const sol = solve3(S, rhs);
  if (!sol) return { a: 0, b: 0, c: 0, n, ok: false };
  const [a, b, c] = sol;
  const ok = Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c) && a > 0;
  return { a: ok ? a : 0, b: ok ? b : 0, c: ok ? c : 0, n, ok };
}

// Integrate dWater/dt = a*(air-water) + b*windSpeed + c forward from `seed`
// along the forecast timestamps (Euler step, variable dt). Because each step
// relaxes toward that hour's forecast air, the trajectory self-corrects and
// stays stable. Zero coeffs yield a flat line (persistence baseline).
export function rollForward(seed, forecastSeries, coeffs, opts = {}) {
  const horizonH = opts.horizonH ?? HORIZON_H;
  const { a, b, c } = coeffs;
  const cutoff = seed.epoch + horizonH * 3600;
  let w = seed.water;
  let tPrev = seed.epoch;
  const out = [];
  for (const f of forecastSeries) {
    if (f.epoch <= seed.epoch) continue;
    if (f.epoch > cutoff) break;
    if (f.air == null || f.windSpeed == null) continue;
    const dtH = (f.epoch - tPrev) / 3600;
    if (dtH <= 0) continue;
    w = w + dtH * (a * (f.air - w) + b * f.windSpeed + c);
    out.push({ epoch: f.epoch, water: w });
    tPrev = f.epoch;
  }
  return out;
}
