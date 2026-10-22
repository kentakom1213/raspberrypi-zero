import { discomfortIndex } from "./comfort.mjs";
import {
  GROUP_SIZES, METRICS, isoDay, jstDay, parseDay, addDays, addMonths,
  startOf, advance, dateRangeQuery, expectedSamples, coverage,
  metricValue, formatValue, heatColor, monthDays, bucketIndex,
  periodWindow, compareWindows,
} from "./stats-utils.mjs";

const $ = (id) => document.getElementById(id);
const COLORS = { temperature: "#c9672c", humidity: "#327bad" };
const TODAY = () => jstDay(Date.now());
const today = () => parseDay(TODAY());
const charts = new Map();
const cache = new Map();
let serial = 0;
let detailSerial = 0;

function parseState() {
  const p = new URLSearchParams(location.search);
  const now = today();
  const year = Number(p.get("year"));
  const month = Number(p.get("month"));
  const date = parseDay(p.get("date"));
  const group = Object.hasOwn(GROUP_SIZES, p.get("group")) ? p.get("group") : "day";
  const selectedMetric = p.get("metric");
  const trendMetric = p.get("trend_metric");
  const defaultStart = periodWindow(group).start;
  const start = parseDay(p.get("start"));
  const maxStart = periodWindow(group).start;
  const calendarMode = p.get("mode") === "year" ? "year" : "month";
  const selectedYear = Number.isInteger(year) && year >= 2000 && year <= now.getUTCFullYear()
    ? year : now.getUTCFullYear();
  const selectedMonth = Number.isInteger(month) && month >= 1 && month <= 12
    ? month : now.getUTCMonth() + 1;
  const monthEnd = addDays(addMonths(new Date(Date.UTC(selectedYear, selectedMonth - 1, 1)), 1), -1);
  const yearEnd = new Date(Date.UTC(selectedYear, 11, 31));
  const latest = calendarMode === "year" ? yearEnd : monthEnd;
  const effectiveLatest = latest > now ? now : latest;
  const samePeriod = date && (calendarMode === "year"
    ? date.getUTCFullYear() === selectedYear
    : date.getUTCFullYear() === selectedYear && date.getUTCMonth() + 1 === selectedMonth);
  return {
    view: ["calendar", "trend", "compare"].includes(p.get("view")) ? p.get("view") : "calendar",
    calendarMode,
    year: selectedYear,
    month: selectedMonth,
    day: samePeriod && date <= now ? isoDay(date) : isoDay(effectiveLatest),
    metric: Object.hasOwn(METRICS, selectedMetric) ? selectedMetric : "temperature",
    group,
    trendMetric: ["temperature", "humidity"].includes(trendMetric) ? trendMetric : "temperature",
    trendStart: start && start <= maxStart && start >= new Date(Date.UTC(2000,0,1))
      ? startOf(start, group) : defaultStart,
    compareDays: [7, 30, 90].includes(Number(p.get("days"))) ? Number(p.get("days")) : 30,
    basis: p.get("basis") === "year" ? "year" : "previous",
  };
}
let state = parseState();
function stateUrl() {
  const p = new URLSearchParams({
    view: state.view, mode: state.calendarMode, year: state.year,
    month: state.month, date: state.day, metric: state.metric,
    group: state.group, trend_metric: state.trendMetric,
    start: isoDay(state.trendStart), days: state.compareDays, basis: state.basis,
  });
  return "/stats?" + p;
}
function change(patch, push = true) {
  state = { ...state, ...patch };
  if (push) history.pushState(null, "", stateUrl());
  load();
}
async function fetchStats(from, to, group) {
  const url = dateRangeQuery(from, to, group);
  if (!cache.has(url)) {
    const promise = fetch(url, { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error("集計 API エラー：" + response.status);
      return response.json();
    }).catch((error) => { cache.delete(url); throw error; });
    cache.set(url, promise);
  }
  return cache.get(url);
}
function setLoading(value) { $("statsLoading").hidden = !value; }
function setError(text) {
  $("statsError").textContent = text;
  $("statsError").hidden = !text;
}
function hasData(bucket) { return Boolean(bucket && bucket.count > 0); }
function unit(metric) { return METRICS[metric]?.unit || ""; }
function fmt(bucket, metric) { return formatValue(metricValue(bucket, metric), unit(metric)); }
function formatShort(day) { return day.replace(/^(\d{4})-(\d{2})-(\d{2})$/, (_, y, m, d) => `${Number(m)}/${Number(d)}`); }
function prettyDay(day) {
  const date = parseDay(day);
  return date ? `${date.getUTCFullYear()}年${date.getUTCMonth()+1}月${date.getUTCDate()}日` : day;
}
function percent(bucket, day) {
  const c = coverage(bucket, day);
  return c == null ? "—" : c.toFixed(1) + "%";
}
function control(selector, active) {
  document.querySelectorAll(selector).forEach((b) => {
    b.setAttribute("aria-pressed", String(active(b)));
  });
}
function destroyChart(name) {
  charts.get(name)?.destroy();
  charts.delete(name);
}
function buildChart(name, id, settings) {
  destroyChart(name);
  if (typeof Chart === "undefined") return;
  charts.set(name, new Chart($(id), settings));
}
const baseChartOptions = (yLabel) => ({
  responsive: true, maintainAspectRatio: false, animation: false,
  interaction: { mode: "index", intersect: false },
  plugins: {
    legend: { labels: { font: { size: 11 }, boxWidth: 10 } },
    tooltip: { mode: "index", intersect: false },
  },
  scales: {
    x: { ticks: { maxTicksLimit: 8, maxRotation: 0 }, grid: { color: "#f1eeeb" } },
    y: {
      title: { display: !!yLabel, text: yLabel, font: { size: 11 } },
      ticks: { maxTicksLimit: 6 },
      grid: { color: "#eee9e4" },
    },
  },
});
function textCell(row, value) {
  const td = document.createElement("td");
  td.textContent = String(value);
  row.append(td);
}
function clearCharts(...names) { names.forEach(destroyChart); }

function updateTabs() {
  for (const tab of ["calendar", "trend", "compare"]) {
    $("view-" + tab).hidden = state.view !== tab;
    $("tab-" + tab).setAttribute("aria-selected", String(state.view === tab));
    $("tab-" + tab).tabIndex = state.view === tab ? 0 : -1;
  }
}
async function load() {
  const token = ++serial;
  updateTabs();
  setError("");
  setLoading(true);
  try {
    if (state.view === "calendar") await renderCalendar(token);
    else if (state.view === "trend") await renderTrend(token);
    else await renderCompare(token);
  } catch (e) {
    if (token === serial) setError("データを取得できませんでした．" + (e?.message || ""));
  } finally {
    if (token === serial) setLoading(false);
  }
}
function calendarStart() { return new Date(Date.UTC(state.year, 0, 1)); }
function yearData() { return fetchStats(calendarStart(), new Date(Date.UTC(state.year + 1, 0, 1)), "day"); }
function dayButton(day, index, bucket, mini = false) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = mini ? "annual-day" : "calendar-day";
  b.title = prettyDay(day) + "　" + fmt(bucket, state.metric) +
    "　測定件数：" + (bucket?.count ?? 0).toLocaleString("ja-JP");
  b.setAttribute("aria-label", b.title);
  b.setAttribute("aria-pressed", String(day === state.day));
  const value = metricValue(bucket, state.metric);
  b.dataset.missing = String(value == null);
  b.dataset.low = String(hasData(bucket) && (coverage(bucket, day) ?? 100) < 80);
  b.style.background = heatColor(value, state.metric);
  if (!mini) {
    const number = document.createElement("span");
    number.className = "calendar-day-number";
    number.textContent = String(index);
    const info = document.createElement("span");
    info.className = "calendar-day-value";
    info.textContent = value == null ? "—" : value.toFixed(1);
    b.append(number, info);
  }
  if (day > TODAY()) b.disabled = true;
  b.addEventListener("click", () => {
    const d = parseDay(day);
    change({ day, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
  });
  return b;
}
function renderMonth(index) {
  const grid = $("calendarGrid");
  grid.replaceChildren();
  for (const day of monthDays(state.year, state.month)) {
    if (day) {
      grid.append(dayButton(day, Number(day.slice(-2)), index.get(day)));
    } else {
      const pad = document.createElement("div");
      pad.className = "calendar-pad";
      grid.append(pad);
    }
  }
}
function renderAnnual(index) {
  const parent = $("annualHeatmap");
  parent.replaceChildren();
  const axis = document.createElement("div");
  axis.className = "annual-axis";
  axis.append(document.createElement("span"));
  for (let d = 1; d <= 31; d++) {
    const cell = document.createElement("span");
    cell.textContent = [1, 5, 10, 15, 20, 25, 31].includes(d) ? String(d) : "";
    axis.append(cell);
  }
  parent.append(axis);
  for (let m = 1; m <= 12; m++) {
    const line = document.createElement("div");
    line.className = "annual-month";
    const title = document.createElement("strong");
    title.textContent = m + "月";
    line.append(title);
    const length = new Date(Date.UTC(state.year, m, 0)).getUTCDate();
    for (let d = 1; d <= 31; d++) {
      if (d > length) {
        line.append(document.createElement("span"));
      } else {
        const day = isoDay(new Date(Date.UTC(state.year, m - 1, d)));
        line.append(dayButton(day, d, index.get(day), true));
      }
    }
    parent.append(line);
  }
}
function renderCalendarTable(index) {
  const parent = $("calendarRows");
  parent.replaceChildren();
  const start = state.calendarMode === "year" ? new Date(Date.UTC(state.year, 0, 1)) :
    new Date(Date.UTC(state.year, state.month - 1, 1));
  const end = state.calendarMode === "year" ? new Date(Date.UTC(state.year + 1, 0, 1)) :
    addMonths(start, 1);
  for (let day = start; day < end && isoDay(day) <= TODAY(); day = addDays(day, 1)) {
    const date = isoDay(day), bucket = index.get(date);
    const tr = document.createElement("tr");
    if (date === state.day) tr.className = "table-row-selected";
    const td = document.createElement("td");
    const link = document.createElement("button");
    link.type = "button";
    link.className = "row-link";
    link.textContent = formatShort(date);
    link.addEventListener("click", () => change({ day: date }));
    td.append(link); tr.append(td);
    for (const key of ["temperature", "temperature_max", "temperature_min", "humidity"]) {
      textCell(tr, fmt(bucket, key));
    }
    textCell(tr, (bucket?.count || 0).toLocaleString("ja-JP"));
    textCell(tr, percent(bucket, date));
    parent.append(tr);
  }
}
function renderDailySummary(index) {
  const day = state.day;
  $("dayTitle").textContent = prettyDay(day) + "（JST）";
  $("dayNext").disabled = day >= TODAY();
  const bucket = index.get(day);
  $("dayEmpty").hidden = hasData(bucket);
  $("dayTemperature").textContent = fmt(bucket, "temperature");
  $("dayHumidity").textContent = fmt(bucket, "humidity");
  $("dayMax").textContent = fmt(bucket, "temperature_max");
  $("dayMin").textContent = fmt(bucket, "temperature_min");
  $("dayDI").textContent = fmt(bucket, "discomfort");
  $("dayCoverage").textContent = hasData(bucket)
    ? (bucket.count.toLocaleString("ja-JP") + " 件 ／ " + percent(bucket, day)) : "—";
  return bucket;
}
async function renderDayCharts(token, index) {
  const current = ++detailSerial;
  if (!hasData(index.get(state.day))) {
    clearCharts("day", "phase"); return;
  }
  const start = parseDay(state.day), end = addDays(start, 1);
  const data = await fetchStats(start, end, "hour");
  if (token !== serial || current !== detailSerial) return;
  const buckets = data.buckets || [];
  const valid = buckets.filter(hasData);
  const labels = buckets.map(b => {
    const hour = new Date(b.bucket_start_ms + 9*3600*1000).getUTCHours();
    return String(hour).padStart(2, "0") + ":00";
  });
  const opt = baseChartOptions("");
  opt.scales.y.title.display = true;
  opt.scales.y.title.text = "気温（℃）";
  opt.scales.yHumidity = {
    position: "right", title: { display: true, text: "湿度（%）" },
    grid: { drawOnChartArea: false }, min: 0, max: 100,
  };
  buildChart("day", "dayChart", {
    type: "line",
    data: { labels, datasets: [
      { label: "気温（℃）", data: buckets.map(b=>hasData(b)?b.temperature_avg:null),
        borderColor: COLORS.temperature, yAxisID: "y", pointRadius: 1.5,
        spanGaps: false, tension: 0.14 },
      { label: "湿度（%）", data: buckets.map(b=>hasData(b)?b.humidity_avg:null),
        borderColor: COLORS.humidity, yAxisID: "yHumidity", pointRadius: 1.5,
        spanGaps: false, tension: 0.14 },
    ]}, options: opt,
  });
  const points = [];
  for (const b of buckets) {
    if (!hasData(b)) { points.push({ x: null, y: null }); continue; }
    points.push({
      x: b.temperature_avg, y: b.humidity_avg,
      time: b.bucket_start_ms,
    });
  }
  const phaseOpts = baseChartOptions("");
  phaseOpts.scales.x.type = "linear";
  phaseOpts.scales.x.title = { display: true, text: "気温（℃）" };
  phaseOpts.scales.y.title = { display: true, text: "湿度（%）" };
  phaseOpts.scales.y.min = 0;
  phaseOpts.scales.y.max = 100;
  phaseOpts.plugins.legend.display = false;
  phaseOpts.interaction.mode = "nearest";
  buildChart("phase", "dayPhase", {
    type: "line",
    data: { datasets: [
      { label: "時間順", data: points, parsing: false,
        borderColor: COLORS.temperature, pointRadius: 2, borderWidth: 2,
        tension: 0, spanGaps: false },
      { label: "最後の測定", data: valid.length ? [{
        x:valid.at(-1).temperature_avg, y:valid.at(-1).humidity_avg,
      }] : [], parsing: false, showLine: false, pointRadius: 6,
      pointBorderColor: "#fff", pointBorderWidth: 2, pointBackgroundColor:COLORS.temperature },
    ]}, options: phaseOpts,
  });
}
async function renderCalendar(token) {
  control("[data-calendar-mode]", b => b.dataset.calendarMode === state.calendarMode);
  $("calendarMetric").value = state.metric;
  const month = state.month;
  $("calendarTitle").textContent = state.calendarMode === "year" ?
    state.year + "年" : state.year + "年" + month + "月";
  $("calNext").disabled = state.calendarMode === "year" ?
    state.year >= today().getUTCFullYear() :
    state.year * 12 + month >= today().getUTCFullYear() * 12 + today().getUTCMonth() + 1;
  $("monthCalendar").hidden = state.calendarMode !== "month";
  $("annualHeatmap").hidden = state.calendarMode !== "year";
  const metric = METRICS[state.metric];
  $("calendarLegendLabel").textContent = metric.label;
  $("heatMin").textContent = metric.low + metric.unit;
  $("heatMax").textContent = metric.high + metric.unit;
  const data = await yearData();
  if (token !== serial) return;
  const index = bucketIndex(data.buckets);
  if (state.calendarMode === "month") renderMonth(index); else renderAnnual(index);
  renderCalendarTable(index);
  renderDailySummary(index);
  renderDayCharts(token, index).catch(e => {
    if (token === serial) setError("時間別データの取得に失敗しました．" + e.message);
  });
}
function groupLabel(bucket, group) {
  const day = jstDay(bucket.bucket_start_ms);
  if (group === "month") return day.slice(0,7);
  if (group === "week") return formatShort(day);
  return formatShort(day);
}
function metricSummaryKpi(label, text, sub, tone) {
  const div = document.createElement("div");
  div.className = "kpi" + (tone ? " kpi-" + tone : "");
  const title = document.createElement("span");
  title.textContent = label;
  const value = document.createElement("strong");
  value.textContent = text;
  div.append(title, value);
  if (sub) {
    const small = document.createElement("small");
    small.textContent = sub;
    div.append(small);
  }
  return div;
}
function trendKpis(summary, previous) {
  const parent = $("trendKpis"); parent.replaceChildren();
  const metric = state.trendMetric, name = metric === "temperature" ? "気温" : "湿度";
  const prior = metricValue(previous, metric);
  const now = metricValue(summary, metric);
  const delta = now == null || prior == null ? "比較データなし" :
    `前期間比 ${now-prior>=0?"+":""}${(now-prior).toFixed(1)} ${unit(metric)}`;
  parent.append(
    metricSummaryKpi("平均"+name, fmt(summary,metric), delta,
      metric === "temperature" ? "temperature" : "humidity"),
    metricSummaryKpi("最高"+name, formatValue(summary?.[metric+"_max"],unit(metric)), ""),
    metricSummaryKpi("最低"+name, formatValue(summary?.[metric+"_min"],unit(metric)), ""),
    metricSummaryKpi("測定件数", (summary?.count||0).toLocaleString("ja-JP")+" 件", ""),
  );
}
function statsLine(name, color, data, other = {}) {
  return { label: name, data, borderColor: color,
    borderWidth: 2, pointRadius: 0, pointHitRadius: 12,
    tension: .12, spanGaps: false, ...other };
}
function renderTrendTable(buckets) {
  const parent = $("trendRows");parent.replaceChildren();
  for (const b of [...buckets].reverse()) {
    const tr = document.createElement("tr");
    textCell(tr, groupLabel(b,state.group));
    const m = state.trendMetric;
    for(const suffix of ["avg","max","min"]) {
      textCell(tr, formatValue(hasData(b)?b[m+"_"+suffix]:null,unit(m)));
    }
    textCell(tr,(b.count||0).toLocaleString("ja-JP"));
    parent.append(tr);
  }
}
async function renderTrend(token) {
  control("[data-trend-group]", b => b.dataset.trendGroup === state.group);
  control("[data-trend-metric]", b => b.dataset.trendMetric === state.trendMetric);
  const start = state.trendStart, count = GROUP_SIZES[state.group];
  const end = advance(start,state.group,count);
  const earliest = periodWindow(state.group).start;
  $("trendNext").disabled = start >= earliest;
  $("trendPeriod").textContent = `${isoDay(start)} 〜 ${isoDay(addDays(end,-1))}`;
  $("trendHeading").textContent = (state.trendMetric === "temperature"?"気温":"湿度")+"の推移";
  const priorStart = advance(start,state.group,-count);
  const [current, prior] = await Promise.all([
    fetchStats(start,end,state.group),
    fetchStats(priorStart,start,state.group),
  ]);
  if (token !== serial) return;
  const buckets = current.buckets || [], old = prior.buckets || [];
  trendKpis(current.summary,prior.summary);
  renderTrendTable(buckets);
  for (const [slot, metric] of [
    ["trend", state.trendMetric],
    ["trendSecondary", state.trendMetric === "temperature" ? "humidity" : "temperature"],
  ]) {
    if (slot === "trendSecondary") {
      $("trendSecondaryHeading").textContent = (metric === "temperature" ? "気温" : "湿度") + "の推移";
    }
    const col = COLORS[metric];
    const average = (list, suffix) => list.map(b=>hasData(b)?b[metric+"_"+suffix]:null);
    const opt = baseChartOptions(unit(metric));
    const fill = metric === "temperature" ? "rgba(201,103,44,.08)" : "rgba(50,123,173,.08)";
    buildChart(slot, slot === "trend" ? "trendChart" : "trendSecondaryChart", {
      type: "line",
      data: {
        labels: buckets.map(b=>groupLabel(b,state.group)),
        datasets: [
          statsLine("最高",col,average(buckets,"max"),
            { borderWidth:1, fill:{ target:1, above:fill } }),
          statsLine("最低",col,average(buckets,"min"), { borderWidth:1 }),
          statsLine("平均",col,average(buckets,"avg"), { borderWidth:2.8, pointRadius:2 }),
          statsLine("前期間の平均","#95a3ae",average(old,"avg"),
            { borderDash:[5,4], borderWidth:1.7 }),
        ],
      },
      options: opt,
    });
  }
}
function comparisonKpis(current, prior) {
  const parent = $("compareKpis");
  parent.replaceChildren();
  const fields = [
    ["平均気温","temperature","temperature"],
    ["平均湿度","humidity","humidity"],
    ["最高気温","temperature_max","temperature"],
    ["最低気温","temperature_min","humidity"],
  ];
  for (const [label, key, tone] of fields) {
    const a = metricValue(current,key), b = metricValue(prior,key);
    const delta = a != null && b != null
      ? `${a-b>=0?"+":""}${(a-b).toFixed(1)} ${unit(key)}（比較期間比）`
      : "比較データなし";
    parent.append(metricSummaryKpi(label,formatValue(a,unit(key)),delta,tone));
  }
}
function plotComparison(metric, current, prior, days) {
  const id = metric === "temperature" ? "compareTemperature" : "compareHumidity";
  const color = COLORS[metric];
  const own = (current.buckets||[]).map(b=>hasData(b)?b[metric+"_avg"]:null);
  const old = (prior.buckets||[]).map(b=>hasData(b)?b[metric+"_avg"]:null);
  const labels = (current.buckets||[]).map((b,i) =>
    days <= 30 || i%7===0 ? formatShort(jstDay(b.bucket_start_ms)) : "");
  const opt = baseChartOptions(unit(metric));
  opt.plugins.tooltip.callbacks = {
    title: items => items.length ? formatShort(jstDay(current.buckets[items[0].dataIndex].bucket_start_ms)) : "",
  };
  buildChart(id,id,{
    type:"line",data:{
      labels,
      datasets:[
        statsLine("今回",color,own,{ pointRadius:days<=30?1.7:0 }),
        statsLine("比較期間","#9aa7b6",old,{ borderDash:[5,5] }),
      ],
    },options:opt,
  });
}
function compareTable(current,prior,windows) {
  const parent = $("comparisonRows");parent.replaceChildren();
  const entries = [
    [`今回（${formatShort(isoDay(windows.start))}〜${formatShort(isoDay(addDays(windows.end,-1)))})`,current.summary],
    [`比較（${formatShort(isoDay(windows.priorStart))}〜${formatShort(isoDay(addDays(windows.priorEnd,-1)))})`,prior.summary],
  ];
  for(const [name,b] of entries) {
    const row = document.createElement("tr");
    textCell(row,name);
    for(const key of ["temperature","humidity","temperature_max","temperature_min"]) textCell(row,fmt(b,key));
    textCell(row,(b?.count||0).toLocaleString("ja-JP"));
    parent.append(row);
  }
}
async function renderCompare(token) {
  control("[data-compare-days]",b=>Number(b.dataset.compareDays)===state.compareDays);
  control("[data-basis]",b=>b.dataset.basis===state.basis);
  const w = compareWindows(state.compareDays,state.basis);
  $("comparePeriod").textContent =
    `${isoDay(w.start)} 〜 ${isoDay(addDays(w.end,-1))}（${state.basis==="year"?"前年同時期":"直前の同日数"}と比較）`;
  const [current,prior] = await Promise.all([
    fetchStats(w.start,w.end,"day"),
    fetchStats(w.priorStart,w.priorEnd,"day"),
  ]);
  if (token !== serial) return;
  comparisonKpis(current.summary,prior.summary);
  plotComparison("temperature",current,prior,state.compareDays);
  plotComparison("humidity",current,prior,state.compareDays);
  compareTable(current,prior,w);
  $("compareNote").textContent = !(prior.summary?.count>0)
    ? "比較期間に測定記録がないため，差分は表示していません．"
    : "各期間の測定件数が異なる場合，欠測や季節性の影響に注意してください．";
}

document.querySelectorAll("[data-view]").forEach(button => {
  button.addEventListener("click",()=>change({view:button.dataset.view}));
});
$("calendarMetric").addEventListener("change", e=>change({metric:e.target.value}));
document.querySelectorAll("[data-calendar-mode]").forEach(b=>b.addEventListener("click",()=>change({calendarMode:b.dataset.calendarMode})));
$("calPrevious").addEventListener("click",()=>{
  const date = state.calendarMode === "year" ? new Date(Date.UTC(state.year-1,0,1)) :
    addMonths(new Date(Date.UTC(state.year,state.month-1,1)),-1);
  const target = state.calendarMode === "year" ?
    new Date(Date.UTC(date.getUTCFullYear(), 11, 31)) : addDays(addMonths(date, 1), -1);
  change({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,
    day:isoDay(target>today()?today():target)});
});
$("calNext").addEventListener("click",()=>{
  const date = state.calendarMode === "year" ? new Date(Date.UTC(state.year+1,0,1)) :
    addMonths(new Date(Date.UTC(state.year,state.month-1,1)),1);
  if(date>today())return;
  const target = state.calendarMode === "year" ?
    new Date(Date.UTC(date.getUTCFullYear(), 11, 31)) : addDays(addMonths(date, 1), -1);
  change({year:date.getUTCFullYear(),month:date.getUTCMonth()+1,
    day:isoDay(target>today()?today():target)});
});
function changeDay(delta) {
  const next = addDays(parseDay(state.day),delta);
  if (next>today())return;
  change({day:isoDay(next),year:next.getUTCFullYear(),month:next.getUTCMonth()+1});
}
$("dayPrevious").addEventListener("click",()=>changeDay(-1));
$("dayNext").addEventListener("click",()=>changeDay(1));
document.querySelectorAll("[data-trend-metric]").forEach(b=>b.addEventListener("click",()=>change({trendMetric:b.dataset.trendMetric})));
document.querySelectorAll("[data-trend-group]").forEach(b=>b.addEventListener("click",()=>{
  const group=b.dataset.trendGroup;
  change({group,trendStart:periodWindow(group).start});
}));
$("trendPrevious").addEventListener("click",()=>change({trendStart:advance(state.trendStart,state.group,-GROUP_SIZES[state.group])}));
$("trendNext").addEventListener("click",()=>{
  const next=advance(state.trendStart,state.group,GROUP_SIZES[state.group]);
  change({trendStart:next>periodWindow(state.group).start?periodWindow(state.group).start:next});
});
document.querySelectorAll("[data-compare-days]").forEach(b=>b.addEventListener("click",()=>change({compareDays:Number(b.dataset.compareDays)})));
document.querySelectorAll("[data-basis]").forEach(b=>b.addEventListener("click",()=>change({basis:b.dataset.basis})));
window.addEventListener("popstate",()=>{state=parseState();load();});
history.replaceState(null,"",stateUrl());
load();
