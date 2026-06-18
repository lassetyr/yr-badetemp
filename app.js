import { parseNdjson, filterByRange } from "./src/data.js";

const DATA_URL = "data/dulpen.ndjson";
const chart = echarts.init(document.getElementById("chart"));
let allReadings = [];
let currentRange = "30d";

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
    legend: { data: ["Vann", "Luft", "Vind"], top: 0, right: 8 },
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
  const readings = filterByRange(allReadings, currentRange, nowEpoch());
  const empty = document.getElementById("empty");
  if (readings.length === 0) {
    empty.hidden = false;
    chart.clear();
    return;
  }
  empty.hidden = true;
  chart.setOption(buildOption(readings), true);
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
    document
      .querySelectorAll("#ranges button")
      .forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });
}

window.addEventListener("resize", () => chart.resize());

async function init() {
  wireButtons();
  try {
    const res = await fetch(DATA_URL, { cache: "no-store" });
    allReadings = res.ok ? parseNdjson(await res.text()) : [];
  } catch {
    allReadings = [];
  }
  updateHeader();
  render();
}

init();
