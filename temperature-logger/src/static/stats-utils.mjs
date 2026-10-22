import { discomfortIndex } from "./comfort.mjs";

export const GROUP_SIZES = { day: 30, week: 26, month: 12 };
export const METRICS = {
  temperature: { label: "平均気温", unit: "℃", low: 12, high: 35 },
  humidity: { label: "平均湿度", unit: "%", low: 20, high: 90 },
  temperature_max: { label: "最高気温", unit: "℃", low: 12, high: 38 },
  temperature_min: { label: "最低気温", unit: "℃", low: 5, high: 32 },
  discomfort: { label: "不快指数", unit: "", low: 55, high: 85 },
  amplitude: { label: "気温の変動幅", unit: "℃", low: 0, high: 16 },
};
export const JST_MS = 9 * 3600 * 1000;
export const DAY_MS = 86400 * 1000;
export const isoDay = (date) => date.toISOString().slice(0, 10);
export const jstDay = (ms) => new Date(ms + JST_MS).toISOString().slice(0, 10);
export const parseDay = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && isoDay(date) === value ? date : null;
};
export const addDays = (date, number) => new Date(date.getTime() + number * DAY_MS);
export function addMonths(date, number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + number, 1));
}
export function startOf(date, group) {
  const d = new Date(date.getTime());
  if (group === "month") d.setUTCDate(1);
  if (group === "week") d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d;
}
export function advance(date, group, count) {
  return group === "month" ? addMonths(date, count) :
    addDays(date, count * (group === "week" ? 7 : 1));
}
export const jstStart = (day) => Date.parse(day + "T00:00:00+09:00");
export const asJstParam = (day) => day + "T00:00:00+09:00";
export function dateRangeQuery(start, end, group) {
  const params = new URLSearchParams({
    group_by: group, from: asJstParam(isoDay(start)), to: asJstParam(isoDay(end)),
  });
  return "/api/stats?" + params;
}
export function expectedSamples(day, now = Date.now()) {
  const start = jstStart(day);
  if (!Number.isFinite(start) || now < start) return 0;
  return Math.min(1440, Math.ceil((now - start) / 60000));
}
export function coverage(bucket, day, now = Date.now()) {
  const expected = expectedSamples(day, now);
  if (!expected) return null;
  return Math.min(100, 100 * (bucket?.count || 0) / expected);
}
export function metricValue(bucket, metric) {
  if (!bucket || !(bucket.count > 0)) return null;
  if (metric === "discomfort") return discomfortIndex(bucket.temperature_avg, bucket.humidity_avg);
  if (metric === "amplitude") {
    if (bucket.temperature_max == null || bucket.temperature_min == null) return null;
    return bucket.temperature_max - bucket.temperature_min;
  }
  const key = metric === "temperature" || metric === "humidity" ? metric + "_avg" : metric;
  return Number.isFinite(Number(bucket[key])) && bucket[key] != null ? Number(bucket[key]) : null;
}
export function formatValue(value, unit = "", digits = 1) {
  return value == null || !Number.isFinite(value) ? "—" :
    value.toFixed(digits) + (unit ? " " + unit : "");
}
const stops = [
  [140, 190, 236], [195, 224, 233], [240, 230, 181],
  [247, 180, 135], [237, 120, 112],
];
export function heatColor(value, metric) {
  if (value == null || !Number.isFinite(value)) return "#f1efed";
  const { low, high } = METRICS[metric];
  const index = Math.max(0, Math.min(stops.length - 1, (value - low) / (high - low) * (stops.length - 1)));
  const i = Math.min(stops.length - 2, Math.floor(index));
  const t = index - i;
  const rgb = stops[i].map((from, channel) =>
    Math.round(from * (1 - t) + stops[i + 1][channel] * t));
  return `rgb(${rgb.join(",")})`;
}
export function monthDays(year, month) {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const last = addMonths(first, 1);
  const cells = [];
  const offset = (first.getUTCDay() + 6) % 7;
  for (let i = 0; i < offset; i++) cells.push(null);
  for (let d = first; d < last; d = addDays(d, 1)) cells.push(isoDay(d));
  while (cells.length % 7) cells.push(null);
  return cells;
}
export function bucketIndex(buckets) {
  return new Map((buckets || []).map(bucket => [jstDay(bucket.bucket_start_ms), bucket]));
}
export function periodWindow(group, now = Date.now()) {
  const today = parseDay(jstDay(now));
  const current = startOf(today, group);
  const start = advance(current, group, 1 - GROUP_SIZES[group]);
  return { start, end: advance(start, group, GROUP_SIZES[group]) };
}
export function compareWindows(days, basis, end = parseDay(jstDay(Date.now()))) {
  const latest = addDays(end, 1);
  const start = addDays(latest, -days);
  let priorStart, priorEnd;
  if (basis === "year") {
    // Preserve month/day across leap years when possible, with Feb 29 -> Feb 28.
    const previousYear = (date) => {
      const year = date.getUTCFullYear() - 1;
      const month = date.getUTCMonth(), day = date.getUTCDate();
      return new Date(Date.UTC(year, month, Math.min(day,
        new Date(Date.UTC(year, month + 1, 0)).getUTCDate())));
    };
    priorEnd = previousYear(latest);
    priorStart = addDays(priorEnd, -days);
  } else {
    priorEnd = start;
    priorStart = addDays(start, -days);
  }
  return { start, end: latest, priorStart, priorEnd };
}
export function summaryDelta(current, past, metric) {
  const x = metricValue({ count: current?.count, ...current }, metric);
  const y = metricValue({ count: past?.count, ...past }, metric);
  return x == null || y == null ? null : x - y;
}
