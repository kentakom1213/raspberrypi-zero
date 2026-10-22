import assert from "node:assert/strict";
import test from "node:test";
import {
  discomfortIndex, comfortLevel, comfortColor,
  humidityAtIndex, normalizeHistory, phasePoints, timelinePoints,
} from "../../src/static/comfort.mjs";

test("discomfort index matches standard formula at 25C and RH 60%", () => {
  assert.ok(Math.abs(discomfortIndex(25, 60) - 72.82) < 1e-8);
  assert.equal(discomfortIndex(null, 50), null);
  assert.equal(discomfortIndex(20, null), null);
  assert.equal(discomfortIndex(22, 110), null);
});
test("index bands and colors are consistent on both plots", () => {
  for (const [value, label] of [[60, "涼しい"], [70, "おおむね快適"],
    [77, "やや暑い"], [82, "暑い"], [86, "非常に暑い"]]) {
    assert.equal(comfortLevel(value).label, label);
    assert.ok(comfortColor(value).startsWith("#"));
    assert.ok(comfortColor(value, 0.15).startsWith("rgba"));
  }
});
test("contour humidity returns the original discomfort index", () => {
  const di = discomfortIndex(27, 65);
  assert.ok(Math.abs(humidityAtIndex(27, di) - 65) < 1e-8);
});
test("raw/hourly rows retain paired T and RH and exclude empty buckets", () => {
  const raw = normalizeHistory([{ measured_at_ms: 2000, temperature: 25, humidity: 60 },
    { measured_at_ms: 1000, temperature: 24, humidity: 50 },
    { measured_at_ms: 3000, temperature: null, humidity: 80 }]);
  assert.equal(raw.length, 2);
  assert.equal(raw[0].time, 1000);
  assert.equal(raw[1].di, discomfortIndex(25, 60));
  const hourly = normalizeHistory([
    { bucket_start_ms: 1000, count: 60, temperature_avg: 24, humidity_avg: 60 },
    { bucket_start_ms: 2000, count: 0, temperature_avg: null, humidity_avg: null },
  ], true);
  assert.equal(hourly.length, 1);
  assert.equal(hourly[0].temperature, 24);
});
test("gaps break both time and phase trajectories", () => {
  const readings = [
    { time: 1000, temperature: 20, humidity: 45, di: 62 },
    { time: 2000, temperature: 21, humidity: 46, di: 63 },
    { time: 10000, temperature: 22, humidity: 47, di: 64 },
  ];
  const time = timelinePoints(readings, "humidity", 3000);
  const phase = phasePoints(readings, 3000);
  assert.equal(time.length, 4);
  assert.equal(phase.length, 4);
  assert.equal(time[2].y, null);
  assert.equal(phase[2].y, null);
});
