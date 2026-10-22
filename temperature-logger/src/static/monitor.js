import {
  discomfortIndex, comfortColor, humidityAtIndex,
  normalizeHistory, timelinePoints, phasePoints,
} from "/static/comfort.mjs";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const JST_OFFSET = 9 * HOUR;
const periods = { "1h": HOUR, "6h": 6 * HOUR, "24h": DAY, "7d": 7 * DAY };
const colors = { temperature: "#c9672c", humidity: "#327bad" };
const shortTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const hourTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const dayTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
});
const fullTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

let selectedRange = new URLSearchParams(location.search).get("range");
if (!Object.hasOwn(periods, selectedRange)) selectedRange = "6h";
let temperatureChart = null;
let humidityChart = null;
let phaseChart = null;
let activeController = null;
let requestNumber = 0;

function setNotice(message) {
  const element = document.getElementById("notice");
  element.textContent = message;
  element.hidden = !message;
}
function setChartMessage(message) {
  const element = document.getElementById("chartMessage");
  element.textContent = message;
  element.hidden = !message;
}
function setStatus(state, label) {
  document.getElementById("currentStatus").dataset.state = state;
  document.getElementById("statusLabel").textContent = label;
}
function valueText(value) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(1);
}
function renderHealth(data) {
  document.getElementById("temperatureValue").textContent = valueText(data.temperature);
  document.getElementById("humidityValue").textContent = valueText(data.humidity);
  const measured = data.sent_at
    ? Date.parse(data.sent_at.replace(" ", "T") + "+09:00") : NaN;
  document.getElementById("measuredAt").textContent = Number.isFinite(measured)
    ? "最終測定：" + fullTime.format(measured) : "最終測定：—";
  const stale = !Number.isFinite(measured) || Date.now() - measured > 3 * 60_000;
  if (stale) {
    setStatus("stale", Number.isFinite(measured) ? "測定停止の可能性" : "測定待ち");
    setNotice("最終測定から3分以上経過しています．現在値は最新ではない可能性があります．");
  } else if (data.last_error) {
    setStatus("error", "測定・送信エラー");
    setNotice("測定・送信に問題があります．");
  } else {
    setStatus("active", "測定中");
    setNotice("");
  }
  const details = document.getElementById("errorDetails");
  details.hidden = !data.last_error;
  document.getElementById("errorValue").textContent = data.last_error || "";
}

function timeTickStep() {
  if (selectedRange === "1h") return 15 * 60_000;
  if (selectedRange === "6h") return HOUR;
  if (selectedRange === "24h") return 4 * HOUR;
  return DAY;
}
function tickLabel(value) {
  if (selectedRange === "7d") return dayTime.format(value);
  const atMidnight = ((value + JST_OFFSET) % DAY) === 0;
  return selectedRange === "24h" && atMidnight ? dayTime.format(value) : hourTime.format(value);
}
function xAxis(start, end) {
  return {
    type: "linear",
    min: start,
    max: end,
    afterBuildTicks(scale) {
      const step = timeTickStep();
      const anchor = selectedRange === "7d" ? JST_OFFSET : 0;
      let position = Math.ceil((scale.min + anchor) / step) * step - anchor;
      const ticks = [];
      while (position <= scale.max) {
        ticks.push({ value: position });
        position += step;
      }
      scale.ticks = ticks.length ? ticks : [{ value: scale.min }, { value: scale.max }];
    },
    ticks: { maxRotation: 0, autoSkip: true, font: { size: 10 }, callback: tickLabel },
    grid: {
      color: (context) => context.tick &&
          ((context.tick.value + JST_OFFSET) % DAY === 0) ? "#d5cec7" : "#eee9e4",
    },
    border: { display: false },
  };
}

// This plugin draws genuine index-based iso-regions in the phase plane.
// Time plots are shaded VERTICALLY by the simultaneous T/RH index;
// horizontal stripes by temperature or RH alone would be misleading.
const comfortBackground = {
  id: "comfortBackground",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: area, scales } = chart;
    const config = chart.$comfort;
    if (!area || !config) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
    ctx.clip();
    if (config.mode === "time") {
      const rows = config.readings;
      const x = scales.x;
      for (let i = 0; i < rows.length - 1; i++) {
        const current = rows[i];
        const next = rows[i + 1];
        if (next.time - current.time >= config.gapMs) continue;
        const a = Math.max(area.left, x.getPixelForValue(current.time));
        const b = Math.min(area.right, x.getPixelForValue(next.time));
        if (b > a) {
          ctx.fillStyle = comfortColor(current.di, 0.43);
          ctx.fillRect(a, area.top, b - a, area.bottom - area.top);
        }
      }
    } else if (config.mode === "phase") {
      const x = scales.x;
      const y = scales.y;
      const step = 7;
      for (let px = area.left; px < area.right; px += step) {
        for (let py = area.top; py < area.bottom; py += step) {
          const temperature = x.getValueForPixel(Math.min(px + step / 2, area.right));
          const humidity = y.getValueForPixel(Math.min(py + step / 2, area.bottom));
          ctx.fillStyle = comfortColor(discomfortIndex(temperature, humidity), 0.72);
          ctx.fillRect(px, py, Math.min(step + .5, area.right - px),
            Math.min(step + .5, area.bottom - py));
        }
      }
      // Fine contour lines at index thresholds, curved in T/RH coordinates.
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(73,83,94,0.27)";
      ctx.setLineDash([3, 4]);
      for (const index of [65, 75, 80, 85]) {
        ctx.beginPath();
        let connected = false;
        for (let px = area.left; px <= area.right + 1; px += 3) {
          const t = x.getValueForPixel(px);
          const rh = humidityAtIndex(t, index);
          if (rh == null || !Number.isFinite(rh) || rh < y.min || rh > y.max) {
            connected = false;
            continue;
          }
          const py = y.getPixelForValue(rh);
          if (!connected) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
          connected = true;
        }
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    ctx.restore();
  },
};

function createTimeChart(canvas, label, metric, unit) {
  const chart = new Chart(canvas, {
    type: "line",
    plugins: [comfortBackground],
    data: {
      datasets: [{
        label, data: [], parsing: false,
        borderColor: colors[metric], backgroundColor: colors[metric],
        borderWidth: 2, pointRadius: 0, pointHoverRadius: 4,
        pointHitRadius: 12, tension: 0.12, spanGaps: false,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fullTime.format(items[0].parsed.x) + " JST",
            label: (item) => `${label}：${Number(item.parsed.y).toFixed(1)} ${unit}`,
            afterLabel: (item) => item.raw.di == null ? "" :
              `不快指数：${item.raw.di.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: xAxis(Date.now() - periods[selectedRange], Date.now()),
        y: {
          ticks: { maxTicksLimit: 5, font: { size: 10 } },
          grid: { color: "#eee9e4" },
          border: { display: false },
        },
      },
    },
  });
  chart.$comfort = { mode: "time", readings: [], gapMs: 5 * 60_000 };
  return chart;
}
function mixTimeColor(ratio) {
  const t = Math.max(0, Math.min(1, ratio));
  const start = [50, 123, 173];
  const end = [201, 103, 44];
  const values = start.map((v, i) => Math.round(v + (end[i] - v) * t));
  return `rgb(${values.join(",")})`;
}
function phaseBounds(rows) {
  if (!rows.length) return { tMin: 16, tMax: 32, hMin: 25, hMax: 85 };
  const ts = rows.map((row) => row.temperature);
  const hs = rows.map((row) => row.humidity);
  const tMin = Math.min(16, Math.floor((Math.min(...ts) - 1) / 2) * 2);
  const tMax = Math.max(32, Math.ceil((Math.max(...ts) + 1) / 2) * 2);
  const hMin = Math.max(0, Math.min(25, Math.floor((Math.min(...hs) - 4) / 5) * 5));
  const hMax = Math.min(100, Math.max(85, Math.ceil((Math.max(...hs) + 4) / 5) * 5));
  return { tMin, tMax, hMin, hMax };
}
function createPhaseChart(canvas) {
  const chart = new Chart(canvas, {
    type: "line",
    plugins: [comfortBackground],
    data: {
      datasets: [
        {
          label: "変化の軌跡", data: [], parsing: false,
          borderColor: colors.temperature, borderWidth: 2.5,
          pointRadius: 0, pointHoverRadius: 4, pointHitRadius: 9,
          tension: 0.16, spanGaps: false,
          segment: {
            borderColor: (context) => {
              const data = context.chart.data.datasets[0].data;
              const { firstTime, lastTime } = context.chart.$comfort || {};
              const time = data[context.p1DataIndex]?.time;
              if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) ||
                  !Number.isFinite(time)) return colors.temperature;
              return mixTimeColor((time - firstTime) / Math.max(1, lastTime - firstTime));
            },
          },
        },
        {
          label: "最新", data: [], parsing: false, showLine: false,
          pointRadius: 6, pointHoverRadius: 8,
          pointBackgroundColor: colors.temperature,
          pointBorderColor: "#fff", pointBorderWidth: 2.5,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fullTime.format(items[0].raw.time) + " JST",
            label: (item) => {
              const { x, y } = item.parsed;
              return `${x.toFixed(1)} ℃ ／ ${y.toFixed(1)} %`;
            },
            afterLabel: (item) => `不快指数：${item.raw.di.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear", min: 16, max: 32,
          title: { display: true, text: "気温（℃）", font: { size: 11 } },
          ticks: { maxTicksLimit: 7, font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.7)" },
          border: { display: false },
        },
        y: {
          type: "linear", min: 25, max: 85,
          title: { display: true, text: "湿度（%）", font: { size: 11 } },
          ticks: { maxTicksLimit: 7, font: { size: 10 } },
          grid: { color: "rgba(255,255,255,0.7)" },
          border: { display: false },
        },
      },
    },
  });
  chart.$comfort = { mode: "phase" };
  return chart;
}

function renderCharts(rows, start, end, hourly) {
  if (typeof Chart === "undefined") {
    setChartMessage("グラフを読み込めませんでした．");
    return;
  }
  if (!temperatureChart) {
    temperatureChart = createTimeChart(
      document.getElementById("temperatureChart"), "気温", "temperature", "℃");
    humidityChart = createTimeChart(
      document.getElementById("humidityChart"), "湿度", "humidity", "%");
    phaseChart = createPhaseChart(document.getElementById("phaseChart"));
  }

  const history = normalizeHistory(rows, hourly);
  const gapMs = hourly ? 90 * 60_000 : 5 * 60_000;
  for (const [chart, field] of [
    [temperatureChart, "temperature"], [humidityChart, "humidity"],
  ]) {
    chart.$comfort = { mode: "time", readings: history, gapMs };
    chart.data.datasets[0].data = timelinePoints(history, field, gapMs);
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = end;
    chart.update("none");
  }

  const phase = phasePoints(history, gapMs);
  const bounds = phaseBounds(history);
  phaseChart.data.datasets[0].data = phase;
  phaseChart.$comfort = { mode: "phase", firstTime: history[0]?.time, lastTime: history.at(-1)?.time };
  const latest = history.at(-1);
  phaseChart.data.datasets[1].data = latest
    ? [{ x: latest.temperature, y: latest.humidity, time: latest.time, di: latest.di }]
    : [];
  phaseChart.options.scales.x.min = bounds.tMin;
  phaseChart.options.scales.x.max = bounds.tMax;
  phaseChart.options.scales.y.min = bounds.hMin;
  phaseChart.options.scales.y.max = bounds.hMax;
  phaseChart.update("none");

  document.getElementById("phaseInfo").textContent = latest
    ? `最新 DI ${latest.di.toFixed(1)}` : "データなし";
  setChartMessage(history.length ? "" : "この期間の測定データはありません．");
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}
async function refresh() {
  const request = ++requestNumber;
  if (activeController) activeController.abort();
  activeController = new AbortController();
  const end = Date.now();
  const start = end - periods[selectedRange];
  const hourly = selectedRange === "7d";
  const graphUrl = hourly
    ? "/api/stats?interval=hour&start_ms=" + start + "&end_ms=" + end
    : "/api/readings?start_ms=" + start + "&end_ms=" + end + "&limit=10000";
  const results = await Promise.allSettled([
    fetchJson("/health", activeController.signal),
    fetchJson(graphUrl, activeController.signal),
  ]);
  if (request !== requestNumber) return;
  if (results[0].status === "fulfilled") {
    renderHealth(results[0].value);
  } else {
    setStatus("error", "取得失敗");
    setNotice("通信に失敗しました．表示されている測定値は最新ではありません．");
  }
  if (results[1].status === "fulfilled") {
    renderCharts(hourly ? results[1].value.buckets : results[1].value, start, end, hourly);
  } else {
    setChartMessage("グラフを更新できませんでした．次の自動更新で再試行します．");
  }
}
function chooseRange(range) {
  selectedRange = range;
  document.querySelectorAll("[data-range]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.range === range));
  });
  const url = new URL(location.href);
  url.searchParams.set("range", range);
  history.replaceState(null, "", url);
  refresh();
}
document.querySelectorAll("[data-range]").forEach((button) => {
  button.addEventListener("click", () => chooseRange(button.dataset.range));
});
chooseRange(selectedRange);
setInterval(refresh, 60_000);
