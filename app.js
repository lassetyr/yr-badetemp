import { readingsQueryUrl, mapRow } from "./src/data.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./src/config.js";

const LOCATION_ID = "0-10238"; // Dulpen, Holmestrand
const REFRESH_MS = 5 * 60 * 1000;
const chart = echarts.init(document.getElementById("chart"));
const RANGES = ["24h", "7d", "30d", "all"];
let allReadings = [];
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

function buildOption(readings) {
  return {
    grid: { left: 50, right: 50, top: 30, bottom: 40 },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        const p = osloParts(params[0].axisValue, {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        const header = `${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`;
        const rows = params
          .map((s) => `${s.marker}${s.seriesName}: <b>${s.value ?? "–"}</b>`)
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
    xAxis: {
      type: "category",
      data: readings.map((r) => r.time),
      axisLabel: {
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
        data: readings.map((r) => r.water),
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
        data: readings.map((r) => r.air),
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
      },
      {
        name: "Vind",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 1,
        data: readings.map((r) => r.windSpeed),
        lineStyle: { width: 1.5, color: "#94a3b8", type: "dashed" },
        itemStyle: { color: "#94a3b8" },
      },
    ],
  };
}

function render() {
  const empty = document.getElementById("empty");
  if (allReadings.length === 0) {
    empty.hidden = false;
    chart.clear();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(allReadings), true);
}

function updateHeader() {
  if (allReadings.length === 0) return;
  const latest = allReadings[allReadings.length - 1];
  document.getElementById("current-temp").textContent = `${latest.water}°C`;
  const p = osloParts(latest.time, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  document.getElementById("current-asof").textContent =
    `oppdatert ${p.day}.${p.month}.${p.year}, ${p.hour}:${p.minute}`;
}

function wireButtons() {
  document.getElementById("ranges").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-range]");
    if (!btn) return;
    currentRange = btn.dataset.range;
    try {
      localStorage.setItem(RANGE_KEY, currentRange);
    } catch {
      // ignore storage failures (private mode, quota)
    }
    syncRangeButtons();
    loadData();
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
});

// Fetch the current range from Supabase and re-render. On failure, leave the
// existing readings and chart intact — a transient network blip must not blank
// a working chart. Returns true when fresh data was applied.
async function loadData() {
  const url = readingsQueryUrl(SUPABASE_URL, LOCATION_ID, currentRange, nowEpoch());
  try {
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
    });
    if (!res.ok) return false;
    const rows = await res.json();
    allReadings = rows.map(mapRow);
  } catch {
    return false;
  }
  updateHeader();
  render();
  return true;
}

function startRefreshTimer() {
  if (refreshTimerId !== null) return;
  refreshTimerId = setInterval(loadData, REFRESH_MS);
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
    loadData();
    startRefreshTimer();
  }
});

async function init() {
  wireButtons();
  const ok = await loadData();
  // First load with no data: show the empty state explicitly.
  if (!ok) render();
  startRefreshTimer();
}

init();
