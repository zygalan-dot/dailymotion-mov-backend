const readInteger = (name, fallback, min, max) => {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

export const PORT = readInteger("PORT", 8080, 1, 65535);
export const MAX_DURATION_SECONDS = readInteger("MAX_DURATION_SECONDS", 600, 10, 3600);
export const MAX_OUTPUT_BYTES = readInteger("MAX_OUTPUT_MB", 90, 10, 500) * 1024 * 1024;
export const MAX_QUEUE = readInteger("MAX_QUEUE", 4, 1, 20);
export const JOB_TTL_MS = readInteger("JOB_TTL_MINUTES", 30, 5, 180) * 60_000;

const RATE_WINDOW_MS = 15 * 60_000;
const RATE_LIMIT = readInteger("RATE_LIMIT_PER_15_MIN", 5, 1, 100);
const DEFAULT_ORIGIN = "https://dailymotion-mov.higgsfield.app";
const ALLOWED_ORIGINS = new Set(
  (process.env.FRONTEND_ORIGIN || DEFAULT_ORIGIN)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const rateBuckets = new Map();

export function writeJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(payload);
}

export function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

export function requireAllowedOrigin(req, res) {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    writeJson(res, 403, { error: "Origin not allowed." });
    return false;
  }
  return true;
}

const clientIp = (req) =>
  String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .split(",")[0]
    .trim();

export function consumeRateLimit(req) {
  const key = clientIp(req);
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) {
    rateBuckets.set(key, recent);
    return false;
  }
  recent.push(now);
  rateBuckets.set(key, recent);
  return true;
}

export function parseDailymotionUrl(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!["dailymotion.com", "www.dailymotion.com", "dai.ly"].includes(host)) return null;
  return parsed.href;
}

export async function readBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) throw new Error("payload too large");
  }
  return JSON.parse(raw || "{}");
}

setInterval(() => {
  const now = Date.now();
  for (const [key, times] of rateBuckets) {
    const recent = times.filter((time) => now - time < RATE_WINDOW_MS);
    if (recent.length) rateBuckets.set(key, recent);
    else rateBuckets.delete(key);
  }
}, 60_000).unref();
