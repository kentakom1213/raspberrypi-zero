const periods = {
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};
const shortTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const fullTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

let selectedRange = new URLSearchParams(location.search).get("range");
if (!Object.hasOwn(periods, selectedRange)) selectedRange = "24h";
let temperatureChart = null;
let humidityChart = null;
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

function setStatus(state, text) {
  const element = document.getElementById("currentStatus");
  element.dataset.state = state;
  document.getElementById("statusLabel").textContent = text;
}

function renderHealth(data) {
  document.getElementById("temperatureValue").textContent =
    data.temperature == null ? "—" : Number(data.temperature).toFixed(1);
  document.getElementById("humidityValue").textContent =
    data.humidity == null ? "—" : Number(data.humidity).toFixed(1);

  const measured = data.sent_at
    ? new Date(data.sent_at.replace(" ", "T") + "+09:00").getTime()
    : NaN;
  document.getElementById("measuredAt").textContent =
    Number.isFinite(measured) ? "最終測定：" + fullTime.format(measured) : "最終測定：—";
  const stale = !Number.isFinite(measured) || Date.now() - measured > 3 * 60 * 1000;
  if (stale) {
    setStatus("stale", Number.isFinite(measured) ? "測定が停止している可能性があります" : "測定待ちです");
    setNotice("最終測定から3分以上経過しています．現在値として扱わないでください．");
  } else if (data.last_error) {
    setStatus("error", "測定・送信に問題があります");
    setNotice("最新のエラーを確認してください．");
  } else {
    setStatus("active", "測定中");
    setNotice("");
  }
  const details = document.getElementById("errorDetails");
  details.hidden = !data.last_error;
  document.getElementById("errorValue").textContent = data.last_error || "";
}

function pointsWithGaps(rows, field, gapMs) {
  const points = [];
  let previous = null;
  for (const row of rows) {
    const x = row.measured_at_ms ?? row.bucket_start_ms;
    if (previous !== null && x - previous >= gapMs) {
      points.push({ x: previous + Math.min(gapMs, (x - previous) / 2), y: null });
    }
    points.push({ x, y: row[field] });
    previous = x;
  }
  return points;
}

function createChart(canvas, label, color, unit) {
  return new Chart(canvas, {
    type: "line",
    data: {
      datasets: [{
        label, data: [], parsing: false, borderColor: color,
        backgroundColor: color, borderWidth: 2, pointRadius: 0,
        pointHoverRadius: 4, pointHitRadius: 12, tension: 0.18, spanGaps: false,
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
            label: (item) => label + "：" + Number(item.parsed.y).toFixed(1) + " " + unit,
          },
        },
      },
      scales: {
        x: {
          type: "linear", min: Date.now() - periods[selectedRange], max: Date.now(),
          ticks: { maxTicksLimit: 6, maxRotation: 0, callback: (value) => shortTime.format(value) },
          grid: { color: "#f2ece6" },
        },
        y: {
          ticks: { maxTicksLimit: 5 },
          grid: { color: "#f2ece6" },
        },
      },
    },
  });
}

function renderCharts(rows, start, end, hourly) {
  if (typeof Chart === "undefined") {
    setChartMessage("グラフを読み込めませんでした．しばらくしてから再試行してください．");
    return;
  }
  if (!temperatureChart) {
    temperatureChart = createChart(document.getElementById("temperatureChart"), "気温", "#c9672c", "℃");
    humidityChart = createChart(document.getElementById("humidityChart"), "湿度", "#327bad", "%");
  }
  const gap = hourly ? 90 * 60 * 1000 : 5 * 60 * 1000;
  const temperatureField = hourly ? "temperature_avg" : "temperature";
  const humidityField = hourly ? "humidity_avg" : "humidity";
  for (const [chart, field] of [
    [temperatureChart, temperatureField], [humidityChart, humidityField],
  ]) {
    chart.data.datasets[0].data = pointsWithGaps(rows, field, gap);
    chart.options.scales.x.min = start;
    chart.options.scales.x.max = end;
    chart.update("none");
  }
  setChartMessage(rows.length ? "" : "この期間の測定データはありません．");
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal, cache: "no-store" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

async function refresh() {
  const currentRequest = ++requestNumber;
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
  if (currentRequest !== requestNumber) return;
  if (results[0].status === "fulfilled") {
    renderHealth(results[0].value);
  } else {
    setStatus("error", "現在値を取得できません");
    setNotice("通信に失敗しました．表示中の測定値は最新ではない可能性があります．");
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
    button.setAttribute("aria-pressed", button.dataset.range === range);
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
setInterval(refresh, 60 * 1000);
