import { parseNdjson, filterByRange } from "./src/data.js";

const DATA_URL = "data/dulpen.ndjson";
const chart = echarts.init(document.getElementById("chart"));
let allReadings = [];
let currentRange = "30d";

const nowEpoch = () => Math.floor(Date.now() / 1000);

function buildOption(readings) {
  return {
    grid: { left: 50, right: 50, top: 30, bottom: 40 },
    tooltip: { trigger: "axis" },
    legend: { data: ["Water", "Air", "Wind"], top: 0, right: 8 },
    xAxis: {
      type: "category",
      data: readings.map((r) => r.time),
      axisLabel: {
        formatter: (value) => {
          const d = new Date(value);
          const pad = (n) => String(n).padStart(2, "0");
          return `${d.getDate()}.${d.getMonth() + 1} ${pad(d.getHours())}:00`;
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
        name: "Water",
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
        name: "Air",
        type: "line",
        smooth: true,
        showSymbol: false,
        yAxisIndex: 0,
        data: readings.map((r) => r.air),
        lineStyle: { width: 2, color: "#f59e0b" },
        itemStyle: { color: "#f59e0b" },
      },
      {
        name: "Wind",
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
  document.getElementById("current-asof").textContent =
    `as of ${new Date(latest.time).toLocaleString()}`;
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
