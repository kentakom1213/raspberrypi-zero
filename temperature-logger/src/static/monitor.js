import {
  discomfortIndex, comfortColor, humidityAtIndex,
  normalizeHistory, timelinePoints, phasePoints,
  phaseBounds, nearestReadingIndex, comfortBands,
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
let activeHistory = [];
let activeGapMs = 5 * 60_000;
let activeStart = 0;
let activeEnd = 0;
let selectedIndex = -1;
let selectionPinned = false;
let requestedTime = null;
let selectionFrame = null;

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
// Cache the DI background: scrubbing the trajectory must not recompute
// tens of thousands of temperature/humidity cells at every pointer move.
function paintPhaseBackground(chart, area) {
  const { x, y } = chart.scales;
  const width = Math.ceil(area.right - area.left);
  const height = Math.ceil(area.bottom - area.top);
  if (width <= 0 || height <= 0) return;
  const key = [width, height, x.min, x.max, y.min, y.max].join(":");
  if (chart.$phaseBackground?.key !== key) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    const step = 3;
    for (let px = 0; px < width; px += step) {
      for (let py = 0; py < height; py += step) {
        const temperature = x.getValueForPixel(area.left + Math.min(px + 1.5, width));
        const humidity = y.getValueForPixel(area.top + Math.min(py + 1.5, height));
        ctx.fillStyle = comfortColor(discomfortIndex(temperature, humidity), 0.27);
        ctx.fillRect(px, py, Math.min(step, width - px), Math.min(step, height - py));
      }
    }
    ctx.lineWidth = 0.75;
    ctx.strokeStyle = "rgba(80, 88, 96, .16)";
    ctx.setLineDash([3, 4]);
    for (const index of [65, 75, 80, 85]) {
      ctx.beginPath();
      let connected = false;
      for (let px = 0; px < width; px += 2) {
        const temperature = x.getValueForPixel(area.left + px);
        const rh = humidityAtIndex(temperature, index);
        if (rh == null || !Number.isFinite(rh) || rh < y.min || rh > y.max) {
          connected = false;
          continue;
        }
        const py = y.getPixelForValue(rh) - area.top;
        if (connected) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
        connected = true;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    chart.$phaseBackground = { key, canvas };
  }
  chart.ctx.drawImage(chart.$phaseBackground.canvas, area.left, area.top);
}

const comfortBackground = {
  id: "comfortBackground",
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea: area, scales, $comfort: config } = chart;
    if (!area || !config) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
    ctx.clip();
    if (config.mode === "time") {
      for (const band of config.bands || []) {
        const a = Math.max(area.left, scales.x.getPixelForValue(band.start));
        const b = Math.min(area.right, scales.x.getPixelForValue(band.end));
        if (b <= a) continue;
        ctx.fillStyle = comfortColor(band.di, 0.20);
        ctx.fillRect(a, area.top, b - a, area.bottom - area.top);
      }
    } else if (config.mode === "phase") {
      paintPhaseBackground(chart, area);
    }
    ctx.restore();
  },
  afterDatasetsDraw(chart) {
    if (chart.$comfort?.mode !== "time" || selectedIndex < 0) return;
    const reading = activeHistory[selectedIndex];
    const { ctx, chartArea: area, scales } = chart;
    if (!reading || !area) return;
    const px = scales.x.getPixelForValue(reading.time);
    const py = scales.y.getPixelForValue(reading[chart.$field]);
    if (!Number.isFinite(px) || !Number.isFinite(py) || px < area.left || px > area.right) return;
    ctx.save();
    ctx.strokeStyle = "rgba(57, 67, 80, .55)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, area.top);
    ctx.lineTo(px, area.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = chart.$field === "temperature" ? colors.temperature : colors.humidity;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, 4.5, 0, 2 * Math.PI);
    ctx.fill();
    ctx.stroke();
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
      interaction: { mode: "nearest", axis: "x", intersect: false },
      onHover(_event, elements, source) {
        const point = elements.find((item) => item.datasetIndex === 0);
        if (!point) return;
        const time = source.data.datasets[0].data[point.index]?.time;
        if (Number.isFinite(time)) queueSelection(time, true);
      },
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
  chart.$field = metric;
  chart.$comfort = { mode: "time", bands: [] };
  return chart;
}
function mixTimeColor(ratio) {
  const t = Math.max(0, Math.min(1, ratio));
  const start = [50, 123, 173];
  const end = [201, 103, 44];
  const values = start.map((v, i) => Math.round(v + (end[i] - v) * t));
  return `rgb(${values.join(",")})`;
}

function createPhaseChart(canvas) {
  const chart = new Chart(canvas, {
    type: "line",
    plugins: [comfortBackground],
    data: {
      datasets: [
        {
          label: "全期間", data: [], parsing: false,
          borderColor: "rgba(88, 104, 115, .18)", borderWidth: 1.7,
          pointRadius: 0, pointHitRadius: 12,
          tension: 0, spanGaps: false,
        },
        {
          label: "選択時刻まで", data: [], parsing: false,
          borderColor: colors.temperature, borderWidth: 2.1,
          pointRadius: 0, pointHitRadius: 12,
          tension: 0, spanGaps: false,
          segment: {
            borderColor: (context) => {
              const data = context.chart.data.datasets[1].data;
              const { firstTime, lastTime } = context.chart.$comfort || {};
              const time = data[context.p1DataIndex]?.time;
              if (!Number.isFinite(firstTime) || !Number.isFinite(lastTime) ||
                  !Number.isFinite(time)) return colors.temperature;
              const ratio = Math.max(0, Math.min(1,
                (time - firstTime) / Math.max(1, lastTime - firstTime)));
              const rgb = mixTimeColor(ratio);
              // Older parts remain identifiable without overpowering newer ones.
              return rgb.replace("rgb(", "rgba(").replace(")", `,${(0.3 + 0.7 * ratio).toFixed(2)})`);
            },
          },
        },
        {
          label: "選択位置", data: [], parsing: false, showLine: false,
          pointRadius: 6, pointHoverRadius: 8, pointHitRadius: 12,
          pointBackgroundColor: colors.temperature, pointBorderColor: "#fff",
          pointBorderWidth: 2.5,
        },
        {
          label: "最新", data: [], parsing: false, showLine: false,
          pointRadius: 4, pointHoverRadius: 6, pointHitRadius: 10,
          pointBackgroundColor: "#fff", pointBorderColor: colors.temperature,
          pointBorderWidth: 1.6,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: false },
      onHover(event, items, source) {
        if (!source.chartArea ||
            event.x < source.chartArea.left || event.x > source.chartArea.right ||
            event.y < source.chartArea.top || event.y > source.chartArea.bottom) return;
        for (const item of items) {
          const point = source.data.datasets[item.datasetIndex].data[item.index];
          if (!point || !Number.isFinite(point.time) || point.y == null) continue;
          const distance = Math.hypot(item.element.x - event.x, item.element.y - event.y);
          if (distance < 25) {
            queueSelection(point.time, true);
            return;
          }
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: (items) => fullTime.format(items[0].raw.time) + " JST",
            label: (item) => {
              const { x, y } = item.parsed;
              return `${x.toFixed(1)} ℃ ／ ${y.toFixed(1)} %`;
            },
            afterLabel: (item) => item.raw.di == null ? "" :
              `不快指数：${item.raw.di.toFixed(1)}`,
          },
        },
      },
      scales: {
        x: {
          type: "linear", min: 20, max: 30,
          title: { display: true, text: "気温（℃）", font: { size: 11 } },
          ticks: { maxTicksLimit: 7, font: { size: 10 } },
          grid: { color: "rgba(140,147,153,0.09)" },
          border: { display: false },
        },
        y: {
          type: "linear", min: 30, max: 70,
          title: { display: true, text: "湿度（%）", font: { size: 11 } },
          ticks: { maxTicksLimit: 7, font: { size: 10 } },
          grid: { color: "rgba(140,147,153,0.09)" },
          border: { display: false },
        },
      },
    },
  });
  chart.$comfort = { mode: "phase" };
  return chart;
}

function renderTimelineTicks(start, end) {
  const element = document.getElementById("timelineTicks");
  element.replaceChildren();
  const span = end - start;
  if (span <= 0) return;
  const widthNarrow = window.innerWidth < 580;
  const step = selectedRange === "7d" && widthNarrow ? 2 * DAY : timeTickStep();
  const anchor = selectedRange === "7d" ? JST_OFFSET : 0;
  const values = [start];
  let current = Math.ceil((start + anchor) / step) * step - anchor;
  while (current < end) {
    if (current > start + step * 0.28 && current < end - step * 0.28) {
      values.push(current);
    }
    current += step;
  }
  values.push(end);
  for (let i = 0; i < values.length; i++) {
    const time = values[i];
    const label = document.createElement("span");
    label.style.left = `${((time - start) / span * 100).toFixed(3)}%`;
    label.textContent = selectedRange === "7d" ? dayTime.format(time) :
      selectedRange === "24h" ? shortTime.format(time) : hourTime.format(time);
    element.append(label);
  }
}

function applySelection(time, pin = true, force = false) {
  const index = nearestReadingIndex(activeHistory, Number(time));
  const scrubber = document.getElementById("timeScrubber");
  if (index < 0) {
    selectedIndex = -1;
    scrubber.disabled = true;
    document.getElementById("selectedTime").textContent = "測定データなし";
    document.getElementById("selectedMetrics").textContent = "—";
    return;
  }
  const isNew = force || index !== selectedIndex;
  selectedIndex = index;
  const reading = activeHistory[index];
  // Once user returns to the newest position, keep following live updates.
  selectionPinned = Boolean(pin) && index < activeHistory.length - 1;
  requestedTime = reading.time;
  scrubber.disabled = false;
  scrubber.value = String(reading.time);
  const percent = (reading.time - activeStart) / Math.max(1, activeEnd - activeStart) * 100;
  scrubber.style.setProperty("--scrub-progress", `${Math.max(0, Math.min(100, percent))}%`);
  scrubber.setAttribute("aria-valuetext", fullTime.format(reading.time) + " JST");
  document.getElementById("selectedTime").textContent = fullTime.format(reading.time) + " JST";
  document.getElementById("selectedMetrics").textContent =
    `${reading.temperature.toFixed(1)} ℃　${reading.humidity.toFixed(1)} %　DI ${reading.di.toFixed(1)}`;
  document.getElementById("phaseInfo").textContent =
    `最新 DI ${activeHistory.at(-1).di.toFixed(1)}`;

  if (!isNew || !phaseChart) return;
  phaseChart.data.datasets[1].data = phasePoints(
    activeHistory.slice(0, index + 1), activeGapMs, selectedRange === "7d");
  const point = {
    x: reading.temperature, y: reading.humidity, time: reading.time, di: reading.di,
  };
  phaseChart.data.datasets[2].data = [point];
  const latest = activeHistory.at(-1);
  phaseChart.data.datasets[3].data = index === activeHistory.length - 1 ? [] :
    [{ x: latest.temperature, y: latest.humidity, time: latest.time, di: latest.di }];
  phaseChart.update("none");
  temperatureChart?.draw();
  humidityChart?.draw();
}

function queueSelection(time, pin = true) {
  if (nearestReadingIndex(activeHistory, time) === selectedIndex) return;
  pendingTime = time;
  pendingPin = pin;
  if (selectionFrame != null) return;
  selectionFrame = requestAnimationFrame(() => {
    selectionFrame = null;
    applySelection(pendingTime, pendingPin);
  });
}
let pendingTime = null;
let pendingPin = true;

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
  if (selectionFrame != null) {
    cancelAnimationFrame(selectionFrame);
    selectionFrame = null;
  }
  selectedIndex = -1;
  activeHistory = normalizeHistory(rows, hourly);
  activeStart = start;
  activeEnd = end;
  activeGapMs = hourly ? 90 * 60_000 : 5 * 60_000;
  const bucketMs = hourly ? 3 * HOUR : 15 * 60_000;
  const bands = comfortBands(activeHistory, bucketMs, activeGapMs);
  for (const [chart, field] of [
    [temperatureChart, "temperature"], [humidityChart, "humidity"],
  ]) {
    chart.$comfort = { mode: "time", bands };
    chart.data.datasets[0].data = timelinePoints(activeHistory, field, activeGapMs);
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = end;
    chart.update("none");
  }

  const phase = phasePoints(activeHistory, activeGapMs, selectedRange === "7d");
  const bounds = phaseBounds(activeHistory);
  phaseChart.$comfort = {
    mode: "phase",
    firstTime: activeHistory[0]?.time,
    lastTime: activeHistory.at(-1)?.time,
  };
  phaseChart.data.datasets[0].data = phase;
  for (let i = 1; i < phaseChart.data.datasets.length; i++) {
    phaseChart.data.datasets[i].data = [];
  }
  phaseChart.options.scales.x.min = bounds.tMin;
  phaseChart.options.scales.x.max = bounds.tMax;
  phaseChart.options.scales.y.min = bounds.hMin;
  phaseChart.options.scales.y.max = bounds.hMax;
  phaseChart.update("none");

  const scrubber = document.getElementById("timeScrubber");
  scrubber.min = String(start);
  scrubber.max = String(end);
  scrubber.step = "any";
  renderTimelineTicks(start, end);
  applySelection(selectionPinned ? requestedTime : activeHistory.at(-1)?.time, selectionPinned, true);
  setChartMessage(activeHistory.length ? "" : "この期間の測定データはありません．");
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
