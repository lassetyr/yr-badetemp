import {
  readingsQueryUrl,
  latestReadingUrl,
  forecastQueryUrl,
  mapForecast,
  clampForecast,
  mapRow,
  rangeBounds,
  toSeriesPairs,
  waterStats,
  isStale,
  humanizeAge,
  degToArrow,
  waterTrend,
} from "./src/data.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./src/config.js";

const LOCATION_ID = "0-10238"; // Dulpen, Holmestrand
const REFRESH_MS = 5 * 60 * 1000;
const chart = echarts.init(document.getElementById("chart"));
const RANGES = ["24h", "7d", "30d", "all"];

// UI thresholds (policy lives here; src/data.js stays free of it).
const STALE_THRESHOLD_SEC = 2 * 3600; // header "utdatert" badge
const FORECAST_STALE_SEC = 3 * 3600; // drop a projection older than 3h (poller likely stalled)
const TREND_SAMPLE = 3; // readings averaged at each end for the period trend
// How far ahead (hours) to DRAW the 48h projection per selected range. The full
// projection is always stored/fetched; wider ranges have room for all of it, and
// 24t is trimmed so the observed data keeps its share of the chart.
const FORECAST_HORIZON_H = { "24h": 12, "7d": 48, "30d": 48, "all": 48 };
let allReadings = [];
let latest = null;
let forecast = null; // { line, lower, band } | null — the stored 48h projection
let refreshTimerId = null;

// Which chart series are toggled on/off in the legend, persisted across reloads.
const LEGEND_KEY = "yr-badetemp:legend";
let legendSelected = loadLegendSelected();

function loadLegendSelected() {
  try {
    return JSON.parse(localStorage.getItem(LEGEND_KEY)) || undefined;
  } catch {
    return undefined;
  }
}

// Which time range is selected, persisted across reloads.
const RANGE_KEY = "yr-badetemp:range";
let currentRange = loadRange();

function loadRange() {
  try {
    const stored = localStorage.getItem(RANGE_KEY);
    return RANGES.includes(stored) ? stored : "30d";
  } catch {
    return "30d";
  }
}

const nowEpoch = () => Math.floor(Date.now() / 1000);

// "+0,4" / "-1,0" — Norwegian comma, explicit sign, one decimal.
const signedTemp = new Intl.NumberFormat("nb-NO", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
  signDisplay: "always",
});

// "16,1" — Norwegian comma, one decimal, no sign. Used for any measured value
// (water/air °C, wind m/s) in the stats row and tooltip.
const nf1 = new Intl.NumberFormat("nb-NO", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

// Unit shown after each series value in the tooltip.
const SERIES_UNIT = {
  Vann: "°C",
  Luft: "°C",
  Vind: "m/s",
  "Vann (prognose)": "°C",
  "Luft (prognose)": "°C",
  "Vind (prognose)": "m/s",
};

// Format an ISO time string in Norwegian time (Europe/Oslo), independent of
// the viewer's device timezone. Returns the requested date/time parts by name.
function osloParts(isoTime, opts) {
  return new Intl.DateTimeFormat("nb-NO", {
    timeZone: "Europe/Oslo",
    hourCycle: "h23",
    ...opts,
  })
    .formatToParts(new Date(isoTime))
    .reduce((acc, part) => ((acc[part.type] = part.value), acc), {});
}

// Dashed forecast series for the clamped forecast `fc`, honoring the legend:
// each line is drawn only when its observed counterpart is enabled (undefined
// `selected` → all enabled). The water projection also carries its confidence
// band as two silent helper series (names prefixed `_` are hidden from tooltip).
function forecastSeries(fc, selected) {
  if (!fc) return [];
  const on = (name) => selected?.[name] !== false;
  const out = [];
  if (on("Vann")) {
    out.push(
      {
        name: "_prognoseLo",
        type: "line",
        stack: "prognose-band",
        yAxisIndex: 0,
        data: fc.lower,
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        z: 1,
      },
      {
        name: "_prognoseBand",
        type: "line",
        stack: "prognose-band",
        yAxisIndex: 0,
        data: fc.band,
        showSymbol: false,
        silent: true,
        lineStyle: { opacity: 0 },
        areaStyle: { color: "rgba(14,165,233,0.15)" },
        z: 1,
      },
      {
        name: "Vann (prognose)",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: fc.line,
        lineStyle: { width: 2, color: "#0ea5e9", type: "dashed" },
        itemStyle: { color: "#0ea5e9" },
        z: 3,
      },
    );
  }
  if (on("Luft")) {
    out.push({
      name: "Luft (prognose)",
      type: "line",
      smooth: true,
      showSymbol: false,
      yAxisIndex: 0,
      data: fc.airLine,
      lineStyle: { width: 2, color: "#f59e0b", type: "dashed" },
      itemStyle: { color: "#f59e0b" },
      z: 3,
    });
  }
  if (on("Vind")) {
    out.push({
      name: "Vind (prognose)",
      type: "line",
      smooth: true,
      showSymbol: false,
      yAxisIndex: 1,
      data: fc.windLine,
      lineStyle: { width: 1.5, color: "#94a3b8", type: "dashed" },
      itemStyle: { color: "#94a3b8" },
      z: 3,
    });
  }
  return out;
}

function buildOption(readings, forecast, rangeKey, nowEpochSec) {
  const bounds = rangeBounds(rangeKey, nowEpochSec);
  // Trim how much of the projection is drawn for the selected range (the full 48h
  // is always stored/fetched; only the display is capped). The clamped `fc` drives
  // both the series and the axis right-edge below.
  const fc = clampForecast(forecast, nowEpochSec, FORECAST_HORIZON_H[rangeKey] ?? 48);
  // When a projection is present, extend the right edge to its last drawn point so
  // the dashed line + band aren't clipped by the now-pinned axis max.
  const fcMaxMs = fc?.line?.length ? fc.line[fc.line.length - 1][0] : null;
  const axisMax = fcMaxMs != null && fcMaxMs > bounds.max ? fcMaxMs : bounds.max;
  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)",
  ).matches;
  // ms timestamp → reading, so the tooltip can enrich the Vind row with the
  // gust/direction fields that aren't part of the plotted [ms, value] pairs.
  const byMs = new Map(readings.map((r) => [r.epoch * 1000, r]));
  return {
    animation: !reducedMotion,
    grid: { left: 50, right: 50, top: 30, bottom: 60 },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        if (!params || !params.length) return "";
        const p = osloParts(params[0].axisValue, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        // One row per metric: prefer the observed value, fall back to the
        // forecast value where there's no observation (the future region). This
        // avoids duplicate observed/"(prognose)" rows at the seam, where the
        // forecast's connecting seed shares the last observed timestamp.
        const byName = new Map(
          params
            .filter((s) => !s.seriesName.startsWith("_")) // drop band helper series
            .map((s) => [s.seriesName, s]),
        );
        const pick = (observed, forecast) => {
          const o = byName.get(observed);
          if (o && o.value?.[1] != null) return o;
          const f = byName.get(forecast);
          if (f && f.value?.[1] != null) return f;
          return null;
        };
        const chosen = [
          pick("Vann", "Vann (prognose)"),
          pick("Luft", "Luft (prognose)"),
          pick("Vind", "Vind (prognose)"),
        ].filter(Boolean);
        // The picked values are all-observed or all-forecast (the two overlap
        // only at the seed, where observed wins), so one header tag suffices.
        const isForecast = chosen.some((s) => s.seriesName.endsWith(" (prognose)"));
        const header =
          `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}` +
          (isForecast ? " · prognose" : "");
        const rows = chosen
          .map((s) => {
            const base = s.seriesName.replace(" (prognose)", "");
            const raw = s.value?.[1];
            const unit = SERIES_UNIT[base] ?? "";
            const value = raw == null ? "–" : `${nf1.format(raw)} ${unit}`.trim();
            let line = `${s.marker}${base}: <b>${value}</b>`;
            if (s.seriesName === "Vind" && raw != null) {
              const r = byMs.get(s.value?.[0]);
              line += ` ${degToArrow(r?.windDir) ?? "-"}`;
            }
            if (s.seriesName === "Vind (prognose)" && raw != null) {
              line += ` ${degToArrow(s.value?.[2]) ?? "-"}`; // bearing packed as the 3rd element
            }
            return line;
          })
          .join("<br>");
        return `${header}<br>${rows}`;
      },
    },
    legend: {
      data: ["Vann", "Luft", "Vind"],
      top: 0,
      // Centered so it clears both axis-name corners ("°C" left, "m/s" right).
      left: "center",
      selected: legendSelected,
      // Default legend text (#333) is invisible on the dark panel; use the
      // theme's light text for active items and muted gray for toggled-off ones.
      textStyle: { color: "#e2e8f0", fontSize: 13 },
      inactiveColor: "#64748b",
    },
    dataZoom: [
      { type: "inside" },
      {
        type: "slider",
        height: 18,
        bottom: 8,
        borderColor: "transparent",
        backgroundColor: "rgba(148,163,184,0.08)",
        fillerColor: "rgba(14,165,233,0.18)",
        handleStyle: { color: "#94a3b8" },
        moveHandleStyle: { color: "#94a3b8" },
        dataBackground: {
          lineStyle: { color: "#475569" },
          areaStyle: { color: "#334155" },
        },
        selectedDataBackground: {
          lineStyle: { color: "#0ea5e9" },
          areaStyle: { color: "rgba(14,165,233,0.25)" },
        },
        textStyle: { color: "#94a3b8" },
      },
    ],
    xAxis: {
      type: "time",
      // Right edge pinned to now; left edge spans the selected range (undefined
      // for "all", letting ECharts fit the earliest reading).
      min: bounds.min,
      max: axisMax,
      axisLabel: {
        // Drop labels that would collide rather than letting them overprint —
        // matters on narrow (mobile) widths where the time axis packs in ticks.
        hideOverlap: true,
        formatter: (value) => {
          const p = osloParts(value, {
            day: "numeric",
            month: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          });
          return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
        },
      },
    },
    yAxis: [
      { type: "value", name: "°C", scale: true, position: "left" },
      {
        type: "value",
        name: "m/s",
        scale: true,
        position: "right",
        splitLine: { show: false },
      },
    ],
    series: [
      {
        name: "Vann",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: toSeriesPairs(readings, "water"),
        lineStyle: { width: 3, color: "#0ea5e9" },
        itemStyle: { color: "#0ea5e9" },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: "rgba(14,165,233,0.35)" },
            { offset: 1, color: "rgba(14,165,233,0.02)" },
          ]),
        },
      },
      {
        name: "Luft",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: toSeriesPairs(readings, "air"),
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
      },
      {
        name: "Vind",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        data: toSeriesPairs(readings, "windSpeed"),
        lineStyle: { width: 1.5, color: "#94a3b8" },
        itemStyle: { color: "#94a3b8" },
      },
      ...forecastSeries(fc, legendSelected),
    ],
  };
}

function render() {
  const empty = document.getElementById("empty");
  if (allReadings.length === 0) {
    empty.hidden = false;
    chart.clear();
    updateTrend();
    updateStats();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(allReadings, forecast, currentRange, nowEpoch()), true);
  updateTrend();
  updateStats();
}

function updateTrend() {
  const el = document.getElementById("current-trend");
  const trend = waterTrend(allReadings, TREND_SAMPLE);
  if (!trend) {
    el.hidden = true;
    return;
  }
  // "flat" gets its own wording — a signed "±0,0°" reads as a nonsensical
  // negative zero, so show a neutral "→ uendret" instead.
  el.textContent =
    trend.direction === "flat"
      ? "→ uendret"
      : `${trend.direction === "up" ? "▲" : "▼"} ${signedTemp.format(trend.delta)}°`;
  el.classList.toggle("up", trend.direction === "up");
  el.classList.toggle("down", trend.direction === "down");
  el.classList.toggle("flat", trend.direction === "flat");
  el.hidden = false;
}

function updateStats() {
  const el = document.getElementById("stats");
  const s = waterStats(allReadings);
  if (!s) {
    el.hidden = true;
    return;
  }
  el.textContent =
    `min ${nf1.format(s.min)}° · ` +
    `maks ${nf1.format(s.max)}° · ` +
    `snitt ${nf1.format(s.avg)}°`;
  el.hidden = false;
}

function updateHeader() {
  if (!latest) return;
  document.getElementById("current-temp").textContent = `${latest.water}°C`;
  const p = osloParts(latest.time, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const asOf = document.getElementById("current-asof");
  const now = nowEpoch();
  const age = humanizeAge(now - latest.epoch);
  const stale = isStale(latest.epoch, now, STALE_THRESHOLD_SEC);
  asOf.textContent =
    `oppdatert ${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute} (${age} siden)` +
    (stale ? " ⚠ utdatert" : "");
  asOf.classList.toggle("stale", stale);
}

function wireButtons() {
  document.getElementById("ranges").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    // Switch optimistically, then refetch. Only commit/persist the new range if
    // the fetch succeeds; on failure revert so the active button matches the
    // chart still on screen.
    const prevRange = currentRange;
    currentRange = btn.dataset.range;
    syncRangeButtons();
    const ok = await loadData();
    if (ok) {
      try {
        localStorage.setItem(RANGE_KEY, currentRange);
      } catch {
        // ignore storage failures (private mode, quota)
      }
    } else {
      currentRange = prevRange;
      syncRangeButtons();
    }
  });
  syncRangeButtons();
}

// Mark the button matching the persisted range as active (the HTML defaults to
// 30d, which may differ from what was restored from storage).
function syncRangeButtons() {
  document
    .querySelectorAll("#ranges button")
    .forEach((b) => b.classList.toggle("active", b.dataset.range === currentRange));
}

window.addEventListener("resize", () => chart.resize());

// Persist legend on/off state so a toggled-off series stays off after reload.
chart.on("legendselectchanged", (params) => {
  legendSelected = params.selected;
  try {
    localStorage.setItem(LEGEND_KEY, JSON.stringify(params.selected));
  } catch {
    // ignore storage failures (private mode, quota)
  }
  render(); // re-render so the forecast line follows its observed series' toggle
});

const SUPABASE_HEADERS = {
  apikey: SUPABASE_PUBLISHABLE_KEY,
  Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
};

// Fetch the selected range from Supabase and re-render the chart. On failure,
// leave the existing readings and chart intact — a transient network blip must
// not blank a working chart. Returns true when fresh data was applied.
async function loadData() {
  const url = readingsQueryUrl(SUPABASE_URL, LOCATION_ID, currentRange, nowEpoch());
  try {
    const res = await fetch(url, { cache: "no-store", headers: SUPABASE_HEADERS });
    if (!res.ok) return false;
    const rows = await res.json();
    // Server returns newest-first (epoch.desc); reverse to oldest-first for the
    // left-to-right time axis.
    allReadings = rows.map(mapRow).reverse();
  } catch {
    return false;
  }
  render();
  return true;
}

// Fetch the single most recent reading for the header, independent of the
// selected range, so "current temp" stays correct even when the chosen window
// happens to contain no readings. On failure, leave the existing header intact.
async function loadLatest() {
  try {
    const res = await fetch(latestReadingUrl(SUPABASE_URL, LOCATION_ID), {
      cache: "no-store",
      headers: SUPABASE_HEADERS,
    });
    if (!res.ok) return false;
    const rows = await res.json();
    if (rows.length > 0) {
      latest = mapRow(rows[0]);
      updateHeader();
    }
  } catch {
    return false;
  }
  return true;
}

// Fetch the stored projection for the dashed forecast line + band. On failure,
// leave the existing projection (or its absence) intact — never blank the chart.
async function loadForecast() {
  try {
    const res = await fetch(forecastQueryUrl(SUPABASE_URL, LOCATION_ID), {
      cache: "no-store",
      headers: SUPABASE_HEADERS,
    });
    if (!res.ok) return false;
    const rows = await res.json();
    const row = rows[0];
    // Drop a projection whose row is older than the staleness threshold — a
    // stalled poller must not keep drawing a dashed line from an old seed.
    const genEpoch = row?.generated_at
      ? Math.floor(Date.parse(row.generated_at) / 1000)
      : null;
    const stale = genEpoch != null && nowEpoch() - genEpoch > FORECAST_STALE_SEC;
    forecast = stale ? null : mapForecast(row?.payload);
    // Re-render so a freshly-loaded projection appears immediately, regardless
    // of whether loadData's render ran before `forecast` was set. Guard on
    // readings so we don't force the empty state before loadData populates them
    // (loadData's own render will then include the now-set `forecast`).
    if (allReadings.length > 0) render();
  } catch {
    return false;
  }
  return true;
}

// Refresh header (latest reading), chart (selected range), and projection.
async function refresh() {
  await Promise.all([loadLatest(), loadData(), loadForecast()]);
}

function startRefreshTimer() {
  if (refreshTimerId !== null) return;
  refreshTimerId = setInterval(refresh, REFRESH_MS);
}

function stopRefreshTimer() {
  if (refreshTimerId === null) return;
  clearInterval(refreshTimerId);
  refreshTimerId = null;
}

// Pause polling while the tab is hidden; on return, refetch immediately and
// resume the timer.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopRefreshTimer();
  } else {
    refresh();
    startRefreshTimer();
  }
});

async function init() {
  wireButtons();
  const [, ok] = await Promise.all([loadLatest(), loadData(), loadForecast()]);
  // First load with no data: show the empty state explicitly.
  if (!ok) render();
  startRefreshTimer();
}

init();
