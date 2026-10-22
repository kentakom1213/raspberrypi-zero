import assert from "node:assert/strict";
import test from "node:test";
import {
  isoDay, jstDay, parseDay, addDays, addMonths, monthDays,
  expectedSamples, coverage, metricValue, heatColor, dateRangeQuery,
  GROUP_SIZES, periodWindow, compareWindows,
} from "../../src/static/stats-utils.mjs";

test("JST boundaries, invalid dates and calendar leap days", () => {
  assert.equal(jstDay(Date.parse("2026-10-21T15:00:00Z")), "2026-10-22");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("2026-10-22").toISOString(), "2026-10-22T00:00:00.000Z");
  assert.ok(monthDays(2026, 10).includes("2026-10-31"));
  assert.equal(monthDays(2024, 2).filter(Boolean).length, 29);
  assert.equal(monthDays(2026, 2).filter(Boolean).length, 28);
});
test("calendar range aligned to JST and proper group_by", () => {
  const url = dateRangeQuery(parseDay("2026-01-01"), parseDay("2027-01-01"), "day");
  const params = new URL(url, "https://example.com").searchParams;
  assert.equal(params.get("from"), "2026-01-01T00:00:00+09:00");
  assert.equal(params.get("to"), "2027-01-01T00:00:00+09:00");
  assert.equal(params.get("group_by"), "day");
});
test("heatmap metric uses real aggregates only and missing is distinct", () => {
  const bucket = { count: 20, temperature_avg: 27, humidity_avg: 62, temperature_min: 25, temperature_max: 30 };
  assert.equal(metricValue(bucket, "temperature"), 27);
  assert.equal(metricValue(bucket, "temperature_max"), 30);
  assert.equal(metricValue(bucket, "amplitude"), 5);
  assert.ok(metricValue(bucket, "discomfort") > 70);
  assert.equal(metricValue({count:0,temperature_avg:0}, "temperature"), null);
  assert.equal(metricValue({count:20,temperature_avg:null}, "temperature"), null);
  assert.equal(heatColor(null, "temperature"), "#f1efed");
  assert.ok(heatColor(29, "temperature").startsWith("rgb("));
});
test("coverage of completed and in-progress days is explicit", () => {
  const now = Date.parse("2026-10-22T12:00:00+09:00");
  assert.equal(expectedSamples("2026-10-21", now), 1440);
  assert.equal(expectedSamples("2026-10-22", now), 720);
  assert.equal(expectedSamples("2026-10-23", now), 0);
  assert.equal(coverage({count:720}, "2026-10-22", now), 100);
  assert.ok(coverage({count:500}, "2026-10-21", now) < 80);
});
test("trend and comparison ranges stay within API length limits", () => {
  const now = Date.parse("2026-10-22T18:00:00+09:00");
  for (const group of Object.keys(GROUP_SIZES)) {
    const {start,end} = periodWindow(group, now);
    const periodMs = end.getTime() - start.getTime();
    assert.ok(periodMs <= 400*86400000);
  }
  for (const days of [7,30,90]) {
    for (const basis of ["year","previous"]) {
      const window = compareWindows(days, basis, parseDay("2026-10-22"));
      assert.equal((window.end - window.start) / 86400000,days);
      assert.equal((window.priorEnd - window.priorStart) / 86400000,days);
    }
  }
});
test("month shifting works across years", () => {
  assert.equal(isoDay(addMonths(parseDay("2026-01-01"), -1)), "2025-12-01");
  assert.equal(isoDay(addDays(parseDay("2026-01-01"), -1)), "2025-12-31");
});
