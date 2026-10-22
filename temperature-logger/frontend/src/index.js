/**
 * Public static frontend + guarded read-only Raspberry Pi API gateway.
 *
 * Deliberately fails closed until both PUBLIC_API_ENABLED=true and the
 * Cloudflare VPC Service binding PI_API are configured.
 */
const MAX_READINGS_MS = 8 * 86400000;
const MAX_STATS_MS = 400 * 86400000;
const MINUTE_MS = 60000;
const UPSTREAM = "http://127.0.0.1:8000";
const ROUTES = new Set(["/health", "/api/readings", "/api/stats"]);

function fail(message, status) {
  return Response.json({ error: message }, {
    status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function numeric(value, label) {
  if (!/^\\d{1,16}$/.test(value ?? "")) throw new Error(`${label} は非負整数で指定してください`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} が大きすぎます`);
  return parsed;
}

function dateBound(value, label) {
  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})$/.test(value ?? "")) {
    throw new Error(`${label} はタイムゾーン付き ISO 8601 で指定してください`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) throw new Error(`${label} が不正です`);
  return ms;
}

function rejectUnexpected(params, allowed) {
  const seen = new Set();
  for (const key of params.keys()) {
    if (!allowed.includes(key) || seen.has(key)) {
      throw new Error("不明または重複したパラメータがあります");
    }
    seen.add(key);
  }
}

function checkRange(start, end, max) {
  if (!Number.isFinite(start) || !Number.isFinite(end) ||
      start < 0 || end <= start || end - start > max) {
    throw new Error("取得期間が不正または長すぎます");
  }
}

/**
 * Return a canonical URL used for both the upstream fetch and the cache key.
 * Millisecond boundaries are rounded down to minutes for shared, bounded
 * public-cache keys. The public gateway is deliberately not millisecond-exact.
 */
export function normalizedApiUrl(original) {
  const url = new URL(original);
  if (!ROUTES.has(url.pathname)) throw new Error("API が見つかりません");
  const params = url.searchParams;
  if (url.pathname === "/health") {
    rejectUnexpected(params, []);
  } else if (url.pathname === "/api/readings") {
    rejectUnexpected(params, ["start_ms", "end_ms", "limit"]);
    const ranged = params.has("start_ms") || params.has("end_ms");
    if (ranged && !(params.has("start_ms") && params.has("end_ms"))) {
      throw new Error("start_ms と end_ms は同時に指定してください");
    }
    if (ranged) {
      const start = Math.floor(numeric(params.get("start_ms"), "start_ms") / MINUTE_MS) * MINUTE_MS;
      const end = Math.floor(numeric(params.get("end_ms"), "end_ms") / MINUTE_MS) * MINUTE_MS;
      checkRange(start, end, MAX_READINGS_MS);
      params.set("start_ms", String(start));
      params.set("end_ms", String(end));
    }
    const limit = params.has("limit") ? numeric(params.get("limit"), "limit") : (ranged ? 2000 : 300);
    if (limit < 1 || limit > 2000) throw new Error("limit は 1〜2000 にしてください");
    params.set("limit", String(limit));
  } else {
    rejectUnexpected(params, ["start_ms", "end_ms", "from", "to", "group_by", "interval"]);
    if (params.has("group_by") && params.has("interval")) {
      throw new Error("group_by と interval は同時に指定できません");
    }
    if (params.has("group_by") &&
        !["hour", "day", "week", "month"].includes(params.get("group_by"))) {
      throw new Error("group_by が不正です");
    }
    if (params.has("interval") && !["hour", "day"].includes(params.get("interval"))) {
      throw new Error("interval が不正です");
    }
    const dates = params.has("from") || params.has("to");
    const numbers = params.has("start_ms") || params.has("end_ms");
    if (dates === numbers) throw new Error("期間を from/to または start_ms/end_ms で指定してください");
    let start, end;
    if (dates) {
      if (!params.has("from") || !params.has("to")) throw new Error("from と to は同時に指定してください");
      start = dateBound(params.get("from"), "from");
      end = dateBound(params.get("to"), "to");
    } else {
      if (!params.has("start_ms") || !params.has("end_ms")) {
        throw new Error("start_ms と end_ms は同時に指定してください");
      }
      start = Math.floor(numeric(params.get("start_ms"), "start_ms") / MINUTE_MS) * MINUTE_MS;
      end = Math.floor(numeric(params.get("end_ms"), "end_ms") / MINUTE_MS) * MINUTE_MS;
      params.set("start_ms", String(start));
      params.set("end_ms", String(end));
    }
    checkRange(start, end, MAX_STATS_MS);
  }
  params.sort();
  return url;
}

function ttlFor(url) {
  if (url.pathname === "/health") return 20;
  if (url.pathname === "/api/readings") return 60;
  if (url.searchParams.get("interval") === "hour" ||
      url.searchParams.get("group_by") === "hour") return 60;
  return 300;
}

function browserHeaders() {
  return {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export default {
  async fetch(request, env, ctx) {
    const input = new URL(request.url);
    if (!ROUTES.has(input.pathname)) return fail("Not Found", 404);
    if (request.method !== "GET") return fail("Method Not Allowed", 405);

    // Static files can be deployed without making the private API reachable.
    if (env.PUBLIC_API_ENABLED !== "true" || !env.PI_API || !env.API_RATE_LIMIT) {
      return fail("API は準備中です", 503);
    }

    let target;
    try {
      target = normalizedApiUrl(request.url);
    } catch (error) {
      return fail(error.message, 400);
    }

    // Best-effort per-client limiter. Not a globally strict origin quota.
    const client = request.headers.get("CF-Connecting-IP") || "unidentified";
    try {
      const { success } = await env.API_RATE_LIMIT.limit({ key: client });
      if (!success) return fail("リクエストが多すぎます", 429);
    } catch {
      return fail("API を利用できません", 503);
    }

    // The cache is per Cloudflare location and can be unavailable in some
    // environments (for example, Access-protected previews).
    const cache = globalThis.caches?.default;
    const key = new Request(target.toString());
    if (cache) {
      try {
        const cached = await cache.match(key);
        if (cached) return new Response(cached.body, { status: 200, headers: browserHeaders() });
      } catch {
        // A cache failure must not break the monitor.
      }
    }

    const backend = new URL(target.pathname + target.search, UPSTREAM);
    let response;
    try {
      response = await env.PI_API.fetch(new Request(backend.toString(), {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(7000),
      }));
    } catch {
      return fail("計測サーバーに接続できません", 503);
    }
    if (!response.ok) return fail("計測データを取得できません", 502);

    const declaredSize = Number(response.headers.get("Content-Length") || 0);
    if (declaredSize > 1048576) return fail("応答が大きすぎます", 502);
    let result;
    try {
      const raw = await response.text();
      if (raw.length > 1048576) return fail("応答が大きすぎます", 502);
      result = JSON.parse(raw);
    } catch {
      return fail("計測データの形式が不正です", 502);
    }
    // Don't expose backend/OS errors to anonymous visitors.
    if (target.pathname === "/health" && result && typeof result === "object") {
      result.last_error = result.last_error ? "測定・送信エラーが発生しています" : null;
    }
    const body = JSON.stringify(result);
    if (cache && ctx?.waitUntil) {
      const ttl = ttlFor(target);
      const copy = new Response(body, {
        headers: { "Content-Type": "application/json; charset=utf-8",
                   "Cache-Control": `public, max-age=${ttl}` },
      });
      ctx.waitUntil(cache.put(key, copy).catch(() => {}));
    }
    return new Response(body, { status: 200, headers: browserHeaders() });
  },
};
