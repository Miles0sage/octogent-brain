import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// L3 audit r2 C1 (2026-05-12): bearer-token auth + per-IP rate limit on
// state-changing claude-brain routes (votes/dispatch + drivers/dispatch).
//
// Auth contract:
//   - OCTOGENT_API_KEY env var is the source of truth.
//   - When set: every request to a gated route MUST present either
//     `Authorization: Bearer <key>` OR `X-Octogent-Token: <key>`.
//     A timingSafeEqual comparison prevents trivial timing oracles.
//   - When unset: only loopback IPs (127.0.0.1, ::1) are allowed. Any
//     non-loopback remote address is refused with 401.
//
// Rate limit contract:
//   - 30 requests/minute per remote IP. Exceeding → 429.
//   - In-memory sliding-window-ish bucket (per-IP queue of timestamps).
//   - Limits the worst-case subprocess fan-out an authenticated attacker
//     can drive: even with a valid key + MAX_VOTERS=8, the ceiling is
//     30 × 8 = 240 spawns/min per IP rather than wall-clock unbounded.

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 30;

// L3 audit r3 M5 (2026-05-12): rateLimitBuckets is an unbounded
// in-memory Map keyed on remoteAddress. An attacker rotating source
// IPs (e.g. behind a botnet or shared proxy fleet) could grow the
// map without bound, eventually OOMing the API process. We cap the
// bucket count at RATE_LIMIT_BUCKETS_CAP and evict the oldest
// RATE_LIMIT_EVICT_BATCH entries (FIFO by Map insertion order, which
// JavaScript guarantees) whenever the cap is exceeded. FIFO is a
// reasonable LRU approximation here because chatty hostile IPs are
// re-inserted via .set() on every request — long-quiet legitimate
// IPs are correctly aged out first.
const RATE_LIMIT_BUCKETS_CAP = 10_000;
const RATE_LIMIT_EVICT_BATCH = 1_000;

const rateLimitBuckets = new Map<string, number[]>();

const evictOldestBuckets = (count: number): void => {
  let evicted = 0;
  for (const key of rateLimitBuckets.keys()) {
    if (evicted >= count) break;
    rateLimitBuckets.delete(key);
    evicted += 1;
  }
};

const readApiKey = (): string | null => {
  const key = process.env.OCTOGENT_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
};

const normalizePresentedToken = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const extractBearerHeader = (request: IncomingMessage): string | null => {
  const authHeader = request.headers.authorization;
  if (typeof authHeader === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (match && typeof match[1] === "string" && match[1].length > 0) {
      return match[1];
    }
  }
  const xToken = request.headers["x-octogent-token"];
  if (typeof xToken === "string" && xToken.trim().length > 0) {
    return xToken.trim();
  }
  return null;
};

const extractQueryToken = (request: IncomingMessage): string | null => {
  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    return normalizePresentedToken(url.searchParams.get("octogent_token"));
  } catch {
    return null;
  }
};

const constantTimeEquals = (a: string, b: string): boolean => {
  // timingSafeEqual requires equal-length buffers. Short-circuit when
  // lengths differ — but still do a dummy compare to keep timing flat.
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare equal-length buffers to keep timing flat regardless.
    const filler = Buffer.alloc(bufA.length, 0);
    timingSafeEqual(bufA, filler);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

const isLoopbackRemoteAddress = (remoteAddress: string | undefined): boolean => {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.startsWith("::ffff:")
    ? remoteAddress.slice("::ffff:".length)
    : remoteAddress;
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
};

export type AuthOutcome = { ok: true } | { ok: false; status: 401 | 429; reason: string };

type CheckAuthorizedRequestOptions = {
  allowQueryToken?: boolean;
};

// Single entry point used by every gated route. Returns ok=true when the
// request is permitted; otherwise the route must immediately emit the
// returned status code with the included reason.
export const checkAuthorizedRequest = (
  request: IncomingMessage,
  options: CheckAuthorizedRequestOptions = {},
): AuthOutcome => {
  const apiKey = readApiKey();
  const remoteAddress = request.socket.remoteAddress;
  const isLoopback = isLoopbackRemoteAddress(remoteAddress);

  if (apiKey === null) {
    // No key configured. Default = loopback-only. Override when the
    // operator explicitly opts in via OCTOGENT_ALLOW_REMOTE_ACCESS=1 —
    // this is the same flag they already set to bind the server on
    // 0.0.0.0, so it's not a stealth widening. Single-user dev VPS
    // pattern: the user IS the LAN. Production deployments should set
    // OCTOGENT_API_KEY instead.
    const allowRemote = process.env.OCTOGENT_ALLOW_REMOTE_ACCESS === "1";
    if (!isLoopback && !allowRemote) {
      return {
        ok: false,
        status: 401,
        reason:
          "OCTOGENT_API_KEY is required for non-loopback access (or set OCTOGENT_ALLOW_REMOTE_ACCESS=1 for a single-user dev box)",
      };
    }
  } else {
    const presented =
      extractBearerHeader(request) ??
      (options.allowQueryToken === true ? extractQueryToken(request) : null);
    if (presented === null || !constantTimeEquals(presented, apiKey)) {
      return {
        ok: false,
        status: 401,
        reason: "invalid or missing bearer token",
      };
    }
  }

  // Rate limit (per-IP).
  const ipKey = remoteAddress ?? "unknown";
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = rateLimitBuckets.get(ipKey) ?? [];
  const recent = bucket.filter((t) => t >= cutoff);
  if (recent.length >= RATE_LIMIT_MAX_PER_WINDOW) {
    rateLimitBuckets.set(ipKey, recent);
    return {
      ok: false,
      status: 429,
      reason: `rate limit exceeded: max ${RATE_LIMIT_MAX_PER_WINDOW} requests / ${RATE_LIMIT_WINDOW_MS / 1000}s per IP`,
    };
  }
  recent.push(now);
  // L3 audit r3 M5 (2026-05-12): evict before insert so the post-insert
  // size stays at or below the cap. Existing keys are refreshed by
  // .set() without growing the map, so we only evict when inserting a
  // genuinely new IP.
  if (!rateLimitBuckets.has(ipKey) && rateLimitBuckets.size >= RATE_LIMIT_BUCKETS_CAP) {
    evictOldestBuckets(RATE_LIMIT_EVICT_BATCH);
  }
  rateLimitBuckets.set(ipKey, recent);
  return { ok: true };
};

// L3 audit r3 H1 (2026-05-12): stricter WS-upgrade auth gate.
//
// The HTTP gate above accepts (no API key + OCTOGENT_ALLOW_REMOTE_ACCESS=1)
// for non-loopback callers — the documented single-user dev VPS escape
// hatch. WebSocket upgrades hand the caller a persistent bidirectional
// channel into a spawned PTY, so this lane is hardened: even when
// allow-remote is set with no API key, non-loopback WS upgrades are
// refused. Operator mitigation = set OCTOGENT_API_KEY (same fix as for
// production HTTP).
export const checkAuthorizedWsUpgrade = (request: IncomingMessage): AuthOutcome => {
  const apiKey = readApiKey();
  const remoteAddress = request.socket.remoteAddress;
  const isLoopback = isLoopbackRemoteAddress(remoteAddress);

  if (apiKey === null && !isLoopback) {
    return {
      ok: false,
      status: 401,
      reason:
        "WebSocket upgrades from non-loopback addresses require OCTOGENT_API_KEY",
    };
  }

  // API key set, or loopback + no key. Fall through to the standard
  // gate (bearer header / query token + per-IP rate limit).
  return checkAuthorizedRequest(request, { allowQueryToken: true });
};

// Test-only: reset the in-memory rate limit state. Called by suite
// teardown to keep tests independent.
export const resetAuthState = (): void => {
  rateLimitBuckets.clear();
};

// L3 audit r3 H1 (2026-05-12): test-only inspector for the bucket map
// size. Lets the regression suite assert eviction kicks in without
// reaching into private state.
export const __getRateLimitBucketsSize = (): number => rateLimitBuckets.size;

// L3 audit r3 H3 (2026-05-12): one-line stderr warning when the
// operator launches in a configuration that combines remote exposure
// with no bearer-token requirement. We deliberately do NOT abort —
// the dev-box pattern (single-user VPS) is supported. The warning
// prints exactly once per process via the `printedInsecureWarning`
// guard so re-imports during tests don't spam.
let printedInsecureWarning = false;

export type InsecureBindReason =
  | "allow-remote-no-key"
  | "non-loopback-bind-no-key";

export const warnInsecureConfig = (
  host: string,
  options: { allowRemoteAccess: boolean; stream?: NodeJS.WritableStream } = {
    allowRemoteAccess: false,
  },
): InsecureBindReason | null => {
  if (printedInsecureWarning) return null;
  const stream = options.stream ?? process.stderr;
  const apiKey = readApiKey();
  const isLoopbackBind =
    host === "127.0.0.1" || host === "::1" || host === "localhost";

  let reason: InsecureBindReason | null = null;
  if (apiKey === null && options.allowRemoteAccess) {
    reason = "allow-remote-no-key";
  } else if (apiKey === null && !isLoopbackBind) {
    reason = "non-loopback-bind-no-key";
  }

  if (reason === null) return null;

  const message =
    reason === "allow-remote-no-key"
      ? `⚠ octogent: OCTOGENT_ALLOW_REMOTE_ACCESS=1 without OCTOGENT_API_KEY — the dashboard is reachable from any non-loopback IP without authentication. Set OCTOGENT_API_KEY for production.\n`
      : `⚠ octogent: binding ${host} without OCTOGENT_API_KEY. Set the API key for production or expect rate-limit-only protection.\n`;
  stream.write(message);
  printedInsecureWarning = true;
  return reason;
};

// Test-only: reset the print-once latch so suite teardown can re-arm
// the warning for the next test case.
export const __resetInsecureWarningLatch = (): void => {
  printedInsecureWarning = false;
};

export const withCors = (headers: Record<string, string>, corsOrigin: string | null) => {
  const nextHeaders: Record<string, string> = {
    ...headers,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Octogent-Token",
  };

  if (corsOrigin) {
    nextHeaders["Access-Control-Allow-Origin"] = corsOrigin;
    nextHeaders.Vary = "Origin";
  }

  return nextHeaders;
};

const isLoopbackHostname = (hostname: string) => LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());

const parseHostname = (value: string, withScheme: boolean): string | null => {
  try {
    const url = new URL(withScheme ? value : `http://${value}`);
    return url.hostname;
  } catch {
    return null;
  }
};

export const isAllowedOriginHeader = (origin: string | undefined, allowRemoteAccess: boolean) => {
  if (allowRemoteAccess || origin === undefined) {
    return true;
  }

  const hostname = parseHostname(origin, true);
  return hostname !== null && isLoopbackHostname(hostname);
};

export const isAllowedHostHeader = (host: string | undefined, allowRemoteAccess: boolean) => {
  if (allowRemoteAccess) {
    return true;
  }

  if (!host) {
    return false;
  }

  const hostname = parseHostname(host, false);
  return hostname !== null && isLoopbackHostname(hostname);
};

export const readHeaderValue = (header: string | string[] | undefined): string | undefined => {
  if (typeof header !== "string") {
    return undefined;
  }

  const trimmed = header.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

export const getRequestCorsOrigin = (origin: string | undefined, allowRemoteAccess: boolean) => {
  if (!origin) {
    return null;
  }

  if (!allowRemoteAccess && !isAllowedOriginHeader(origin, allowRemoteAccess)) {
    return null;
  }

  return origin;
};
