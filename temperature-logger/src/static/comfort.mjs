// Standard temperature/humidity discomfort index. A reference, not a health or WBGT measure.
// T: degrees Celsius; H: relative humidity percentage.
export function discomfortIndex(temperature, humidity) {
  if (temperature == null || humidity == null) return null;
  const t = Number(temperature);
  const h = Number(humidity);
  if (!Number.isFinite(t) || !Number.isFinite(h) || h < 0 || h > 100) return null;
  return 0.81 * t + 0.01 * h * (0.99 * t - 14.3) + 46.3;
}

const LEVELS = [
  { below: 65, label: "涼しい", color: "#c5e0f6", rgb: [197, 224, 246] },
  { below: 75, label: "おおむね快適", color: "#cfe9d9", rgb: [207, 233, 217] },
  { below: 80, label: "やや暑い", color: "#f8e6b9", rgb: [248, 230, 185] },
  { below: 85, label: "暑い", color: "#f9cdb1", rgb: [249, 205, 177] },
  { below: Infinity, label: "非常に暑い", color: "#f3b6b4", rgb: [243, 182, 180] },
];

export function comfortLevel(index) {
  if (index == null || !Number.isFinite(index)) return null;
  return LEVELS.find((level) => index < level.below);
}

export function comfortColor(index, alpha = 1) {
  const level = comfortLevel(index);
  if (!level) return "transparent";
  if (alpha >= 1) return level.color;
  return `rgba(${level.rgb.join(",")},${Math.max(0, Math.min(1, alpha))})`;
}

// Keep temperature and humidity from the SAME observation/hour bucket.
// Hourly DI describes hourly mean T/H, not the true mean of all individual DI readings.
export function normalizeHistory(rows, hourly = false) {
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => {
    const time = Number(hourly ? row.bucket_start_ms : row.measured_at_ms);
    const temperature = Number(hourly ? row.temperature_avg : row.temperature);
    const humidity = Number(hourly ? row.humidity_avg : row.humidity);
    if ((!Number.isFinite(time)) || time < 0 ||
        (hourly && row.count === 0) ||
        (hourly ? row.temperature_avg == null || row.humidity_avg == null
          : row.temperature == null || row.humidity == null) ||
        !Number.isFinite(temperature) || !Number.isFinite(humidity) ||
        humidity < 0 || humidity > 100) return null;
    return { time, temperature, humidity,
      di: discomfortIndex(temperature, humidity) };
  }).filter(Boolean).sort((a, b) => a.time - b.time);
}

export function timelinePoints(readings, field, gapMs) {
  const points = [];
  let previous = null;
  for (const row of readings) {
    if (previous && row.time - previous.time >= gapMs) {
      points.push({ x: previous.time + Math.min(gapMs, (row.time - previous.time) / 2), y: null });
    }
    points.push({ x: row.time, y: row[field], time: row.time, di: row.di });
    previous = row;
  }
  return points;
}

export function phasePoints(readings, gapMs, breakAtJstMidnight = false) {
  const points = [];
  let previous = null;
  for (const row of readings) {
    if (previous && (
      row.time - previous.time >= gapMs ||
      (breakAtJstMidnight && jstDay(previous.time) !== jstDay(row.time))
    )) {
      // Do not connect missing intervals or separate JST calendar days.
      points.push({ x: previous.temperature, y: null, time: row.time });
    }
    points.push({
      x: row.temperature, y: row.humidity, time: row.time, di: row.di,
    });
    previous = row;
  }
  return points;
}

// At this T, return the humidity of an iso-discomfort-index contour.
export function humidityAtIndex(temperature, index) {
  const denominator = 0.01 * (0.99 * temperature - 14.3);
  if (Math.abs(denominator) < 1e-8) return null;
  return (index - 0.81 * temperature - 46.3) / denominator;
}

const DAY_MS = 86_400_000;
const JST_MS = 9 * 3_600_000;
export function jstDay(time) {
  return Math.floor((time + JST_MS) / DAY_MS);
}

// Binary search, keeping the requested position on the real time axis.
export function nearestReadingIndex(rows, time) {
  if (!rows.length || !Number.isFinite(time)) return -1;
  let low = 0, high = rows.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (rows[mid].time < time) low = mid + 1;
    else high = mid;
  }
  if (low === 0) return 0;
  if (low === rows.length) return rows.length - 1;
  return time - rows[low - 1].time <= rows[low].time - time ? low - 1 : low;
}

// Track the actual data extent and leave a little breathing room on every side.
export function phaseBounds(rows) {
  if (!rows.length) return { tMin: 20, tMax: 30, hMin: 30, hMax: 70 };
  let tMin = Infinity, tMax = -Infinity, hMin = Infinity, hMax = -Infinity;
  for (const row of rows) {
    tMin = Math.min(tMin, row.temperature);
    tMax = Math.max(tMax, row.temperature);
    hMin = Math.min(hMin, row.humidity);
    hMax = Math.max(hMax, row.humidity);
  }
  const tw = Math.max(4, (tMax - tMin) * 1.25);
  const hw = Math.max(14, (hMax - hMin) * 1.25);
  const tc = (tMin + tMax) / 2, hc = (hMin + hMax) / 2;
  const low = Math.max(0, Math.floor((hc - hw / 2) / 2) * 2);
  const high = Math.min(100, Math.ceil((hc + hw / 2) / 2) * 2);
  return {
    tMin: Math.floor((tc - tw / 2) * 2) / 2,
    tMax: Math.ceil((tc + tw / 2) * 2) / 2,
    hMin: low,
    hMax: Math.max(low + 2, high),
  };
}

// Each band averages DI in 15-minute (or 3-hour) JST-aligned bins.
// Weight observations by covered duration, without filling missing intervals.
// Separate runs prevent a gap from being painted over in a shared bucket.
export function comfortBands(rows, bucketMs, gapMs) {
  if (!(bucketMs > 0) || !(gapMs > 0)) return [];
  const bands = new Map();
  let run = 0;
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const current = rows[i];
    const delta = current.time - previous.time;
    if (delta <= 0 || delta >= gapMs) { run++; continue; }
    let left = previous.time;
    while (left < current.time) {
      const bin = Math.floor((left + JST_MS) / bucketMs) * bucketMs - JST_MS;
      const right = Math.min(current.time, bin + bucketMs);
      const weight = right - left;
      const midpoint = (left + right) / 2;
      const fraction = (midpoint - previous.time) / delta;
      const di = previous.di + fraction * (current.di - previous.di);
      const key = `${run}:${bin}`;
      const band = bands.get(key) || { start: left, end: right, weighted: 0, duration: 0 };
      band.start = Math.min(band.start, left);
      band.end = Math.max(band.end, right);
      band.weighted += di * weight;
      band.duration += weight;
      bands.set(key, band);
      left = right;
    }
  }
  return [...bands.values()]
    .filter((band) => band.duration > 0)
    .map((band) => ({ start: band.start, end: band.end, di: band.weighted / band.duration }))
    .sort((a, b) => a.start - b.start);
}
