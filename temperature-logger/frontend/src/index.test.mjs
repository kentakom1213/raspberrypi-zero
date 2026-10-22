import assert from "node:assert/strict";
import test from "node:test";
import worker, { normalizedApiUrl } from "./index.js";

const base = "https://monitor.example.com";
function url(path) { return base + path; }
function environment(data = {}) {
  const state = { forwarded: [] };
  const env = {
    PUBLIC_API_ENABLED: "true",
    API_RATE_LIMIT: { limit: async () => ({ success: true }) },
    PI_API: {
      fetch: async (request) => {
        state.forwarded.push(request.url);
        return Response.json(data);
      },
    },
  };
  return { env, state };
}
const context = { waitUntil() {} };

test("disabled by default, even if a binding exists", async () => {
  const { env } = environment({ temperature: 23 });
  env.PUBLIC_API_ENABLED = "false";
  const res = await worker.fetch(new Request(url("/health")), env, context);
  assert.equal(res.status, 503);
});
test("fail closed without required bindings", async () => {
  const res = await worker.fetch(new Request(url("/health")), { PUBLIC_API_ENABLED: "true" }, context);
  assert.equal(res.status, 503);
});
test("allowlist rejects arbitrary paths and methods", async () => {
  const { env } = environment();
  assert.equal((await worker.fetch(new Request(url("/private")), env, context)).status, 404);
  assert.equal((await worker.fetch(new Request(url("/api/readings"), { method: "POST" }), env, context)).status, 405);
});
test("normalizes minute boundaries for cacheable readings", () => {
  const result = normalizedApiUrl(url("/api/readings?start_ms=1800000000250&end_ms=1800003600789&limit=100"));
  assert.equal(result.searchParams.get("start_ms"), "1800000000000");
  assert.equal(result.searchParams.get("end_ms"), "1800003600000");
});
test("rejects heavy queries, duplicates, and arbitrary parameters", () => {
  for (const path of [
    "/api/readings?limit=10001",
    "/api/readings?limit=1&limit=2",
    "/api/readings?start_ms=1&end_ms=999999999999",
    "/api/stats",
    "/api/stats?from=2026-01-01T00%3A00%3A00%2B09%3A00&to=2028-01-01T00%3A00%3A00%2B09%3A00",
    "/api/stats?interval=month&start_ms=1800000000000&end_ms=1800003600000",
    "/api/readings?target=http://evil.example",
  ]) {
    assert.throws(() => normalizedApiUrl(url(path)), path);
  }
});
test("accepts the existing Flask monitor limit without fetching more than 2000 rows", () => {
  const result = normalizedApiUrl(url("/api/readings?start_ms=1800000000250&end_ms=1800003600789&limit=10000"));
  assert.equal(result.searchParams.get("limit"), "2000");
});
test("stats preserves calendar ISO dates", () => {
  const result = normalizedApiUrl(url("/api/stats?group_by=month&from=2026-01-01T00%3A00%3A00%2B09%3A00&to=2026-10-01T00%3A00%3A00%2B09%3A00"));
  assert.equal(result.searchParams.get("group_by"), "month");
  assert.equal(result.searchParams.get("from"), "2026-01-01T00:00:00+09:00");
});
test("proxies through fixed private origin and redacts errors", async () => {
  const { env, state } = environment({
    temperature: 24.4, humidity: 52.1, sent_at: "2026-10-20 12:00:00",
    last_error: "private trace /etc/secret",
  });
  const response = await worker.fetch(new Request(url("/health")), env, context);
  assert.equal(response.status, 200);
  assert.equal(state.forwarded[0], "http://127.0.0.1:8000/health");
  const data = await response.json();
  assert.equal(data.temperature, 24.4);
  assert.ok(!data.last_error.includes("/etc/secret"));
});
test("rate limit blocks requests", async () => {
  const { env } = environment();
  env.API_RATE_LIMIT.limit = async () => ({ success: false });
  const response = await worker.fetch(new Request(url("/health")), env, context);
  assert.equal(response.status, 429);
});
test("VPC failure is hidden from visitors", async () => {
  const { env } = environment();
  env.PI_API.fetch = async () => { throw new Error("sensitive server error"); };
  const response = await worker.fetch(new Request(url("/health")), env, context);
  assert.equal(response.status, 503);
  assert.ok(!(await response.text()).includes("sensitive"));
});
