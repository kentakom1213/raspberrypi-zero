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

export function phasePoints(readings, gapMs) {
  const points = [];
  let previous = null;
  for (const row of readings) {
    if (previous && row.time - previous.time >= gapMs) {
      // A null y is a break, preventing false diagonal connections across outages.
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
