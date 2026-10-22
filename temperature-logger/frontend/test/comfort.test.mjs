import assert from "node:assert/strict";
import test from "node:test";
import {
  discomfortIndex, comfortLevel, comfortColor,
  humidityAtIndex, normalizeHistory, phasePoints, timelinePoints,
  nearestReadingIndex, phaseBounds, comfortBands, jstDay,
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

test("JST day crossing breaks a phase trajectory even with continuous samples", () => {
  const nearMidnight = Date.parse("2026-10-20T23:59:00+09:00");
  const rows = [
    { time: nearMidnight, temperature: 26, humidity: 50 },
    { time: nearMidnight + 2 * 60_000, temperature: 27, humidity: 51 },
  ];
  assert.notEqual(jstDay(rows[0].time), jstDay(rows[1].time));
  assert.equal(phasePoints(rows, 5 * 60_000, false).length, 2);
  const split = phasePoints(rows, 5 * 60_000, true);
  assert.equal(split.length, 3);
  assert.equal(split[1].y, null);
});
test("nearest reading follows real timestamps rather than array position", () => {
  const readings = [{ time: 100 }, { time: 200 }, { time: 2_000 }];
  assert.equal(nearestReadingIndex(readings, 199), 1);
  assert.equal(nearestReadingIndex(readings, 1000), 1);
  assert.equal(nearestReadingIndex(readings, 1900), 2);
  assert.equal(nearestReadingIndex(readings, 50), 0);
  assert.equal(nearestReadingIndex([], 400), -1);
});
test("adaptive bounds enclose all points and keep a minimum visible span", () => {
  const near = phaseBounds([{ temperature: 27.8, humidity: 41.3 },
    { temperature: 27.9, humidity: 41.4 }]);
  assert.ok(near.tMax - near.tMin >= 4);
  assert.ok(near.hMax - near.hMin >= 14);
  assert.ok(near.tMin < 27.8 && near.tMax > 27.9);
  assert.ok(near.hMin < 41.3 && near.hMax > 41.4);
  const long = phaseBounds([{ temperature: 18, humidity: 10 },
    { temperature: 33, humidity: 96 }]);
  assert.ok(long.tMin < 18 && long.tMax > 33);
  assert.equal(long.hMin, 0);
  assert.equal(long.hMax, 100);
});
test("weighted comfort bands do not bridge sensor gaps and aggregate values", () => {
  const minute = 60_000;
  const readings = [
    { time: 0, di: 70 },
    { time: minute, di: 72 },
    { time: 2 * minute, di: 74 },
    { time: 20 * minute, di: 80 },
    { time: 21 * minute, di: 82 },
  ];
  const bands = comfortBands(readings, 15 * minute, 5 * minute);
  assert.equal(bands.length, 2);
  assert.deepEqual(bands.map(({ start, end }) => [start, end]), [[0, 2 * minute], [20 * minute, 21 * minute]]);
  assert.ok(Math.abs(bands[0].di - 72) < 1e-8);
});
