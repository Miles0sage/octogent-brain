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

const rateLimitBuckets = new Map<string, number[]>();

const readApiKey = (): string | null => {
  const key = process.env.OCTOGENT_API_KEY?.trim();
  return key && key.length > 0 ? key : null;
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

export type AuthOutcome =
  | { ok: true }
  | { ok: false; status: 401 | 429; reason: string };

// Single entry point used by every gated route. Returns ok=true when the
// request is permitted; otherwise the route must immediately emit the
// returned status code with the included reason.
export const checkAuthorizedRequest = (request: IncomingMessage): AuthOutcome => {
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
        reason: "OCTOGENT_API_KEY is required for non-loopback access (or set OCTOGENT_ALLOW_REMOTE_ACCESS=1 for a single-user dev box)",
      };
    }
  } else {
    const presented = extractBearerHeader(request);
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
  rateLimitBuckets.set(ipKey, recent);
  return { ok: true };
};

// Test-only: reset the in-memory rate limit state. Called by suite
// teardown to keep tests independent.
export const resetAuthState = (): void => {
  rateLimitBuckets.clear();
};

export const withCors = (headers: Record<string, string>, corsOrigin: string | null) => {
  const nextHeaders: Record<string, string> = {
    ...headers,
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
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
