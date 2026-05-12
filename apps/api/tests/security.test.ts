// L3 audit r3 (2026-05-12): regression suite for the v0.2 launch
// blocker hardening. Each describe block targets one gap from the
// audit:
//   - warnInsecureConfig — stderr nudge on insecure boot paths
//   - rate-limit bucket eviction — memory-DoS resistance
//   - WS upgrade strictness — no anonymous WS over non-loopback
//   - audit-log redaction — no plaintext taskInput / rubric on disk
//
// All tests use stubs for IncomingMessage / Socket so we don't bind a
// real port. The helpers below mirror the conventions used in
// upgradeHandler.test.ts + voteRoutes.test.ts (same lane).

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __getRateLimitBucketsSize,
  __resetInsecureWarningLatch,
  checkAuthorizedRequest,
  checkAuthorizedWsUpgrade,
  resetAuthState,
  warnInsecureConfig,
} from "../src/createApiServer/security";
import { createUpgradeHandler } from "../src/createApiServer/upgradeHandler";
import {
  auditPayloadIncluded,
  redactAuditEntry,
} from "../src/cost-cap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const buildRequest = (
  overrides: Partial<{
    remoteAddress: string;
    url: string;
    headers: Record<string, string>;
  }> = {},
): IncomingMessage =>
  ({
    url: overrides.url ?? "/",
    headers: overrides.headers ?? {},
    socket: { remoteAddress: overrides.remoteAddress ?? "127.0.0.1" },
  }) as unknown as IncomingMessage;

type EnvSnapshot = Record<string, string | undefined>;
const captureEnv = (keys: ReadonlyArray<string>): EnvSnapshot => {
  const snap: EnvSnapshot = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
};
const restoreEnv = (snap: EnvSnapshot): void => {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};

// ---------------------------------------------------------------------------
// warnInsecureConfig
// ---------------------------------------------------------------------------

describe("warnInsecureConfig", () => {
  const TRACKED = ["OCTOGENT_API_KEY", "OCTOGENT_ALLOW_REMOTE_ACCESS"] as const;
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = captureEnv(TRACKED);
    delete process.env.OCTOGENT_API_KEY;
    delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    __resetInsecureWarningLatch();
  });
  afterEach(() => {
    restoreEnv(snap);
    __resetInsecureWarningLatch();
  });

  it("emits stderr warning when ALLOW_REMOTE_ACCESS=1 and no API key is set", () => {
    let captured = "";
    const stream = {
      write: (chunk: string) => {
        captured += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const reason = warnInsecureConfig("0.0.0.0", {
      allowRemoteAccess: true,
      stream,
    });
    expect(reason).toBe("allow-remote-no-key");
    expect(captured).toMatch(/OCTOGENT_ALLOW_REMOTE_ACCESS=1/);
    expect(captured).toMatch(/OCTOGENT_API_KEY/);
  });

  it("emits stderr warning on 0.0.0.0 bind without API key (no allowRemote flag)", () => {
    let captured = "";
    const stream = {
      write: (chunk: string) => {
        captured += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const reason = warnInsecureConfig("0.0.0.0", {
      allowRemoteAccess: false,
      stream,
    });
    expect(reason).toBe("non-loopback-bind-no-key");
    expect(captured).toMatch(/binding 0\.0\.0\.0/);
  });

  it("prints the warning only once per process", () => {
    let writes = 0;
    const stream = {
      write: (_chunk: string) => {
        writes += 1;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    warnInsecureConfig("0.0.0.0", { allowRemoteAccess: true, stream });
    warnInsecureConfig("0.0.0.0", { allowRemoteAccess: true, stream });
    warnInsecureConfig("0.0.0.0", { allowRemoteAccess: true, stream });
    expect(writes).toBe(1);
  });

  it("stays silent on loopback bind with API key set", () => {
    process.env.OCTOGENT_API_KEY = "k";
    let captured = "";
    const stream = {
      write: (chunk: string) => {
        captured += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    const reason = warnInsecureConfig("127.0.0.1", {
      allowRemoteAccess: false,
      stream,
    });
    expect(reason).toBe(null);
    expect(captured).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Rate-limit bucket eviction
// ---------------------------------------------------------------------------

describe("rateLimitBuckets eviction", () => {
  const TRACKED = ["OCTOGENT_API_KEY", "OCTOGENT_ALLOW_REMOTE_ACCESS"] as const;
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = captureEnv(TRACKED);
    // Force the loopback-friendly path: no API key, allow remote so we
    // can drive checkAuthorizedRequest with arbitrary IPs without
    // bumping into the auth fail branch (which short-circuits before
    // the rate-limit insertion).
    delete process.env.OCTOGENT_API_KEY;
    process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = "1";
    resetAuthState();
  });
  afterEach(() => {
    resetAuthState();
    restoreEnv(snap);
  });

  it("evicts oldest buckets once size exceeds the 10_000 cap", () => {
    // Drive 10_001 distinct IPs through the gate. After the 10_001st
    // insert the eviction batch should have fired, dropping the size
    // back to 10_001 - 1000 = 9_001.
    for (let i = 0; i < 10_001; i += 1) {
      const remoteAddress = `10.0.${Math.floor(i / 250)}.${i % 250}`;
      const auth = checkAuthorizedRequest(buildRequest({ remoteAddress }));
      // Sanity: each new IP gets ok=true (under per-IP 30/min cap).
      expect(auth.ok).toBe(true);
    }
    const size = __getRateLimitBucketsSize();
    // Eviction batch is 1000, so size post-eviction should be ≤ cap.
    expect(size).toBeLessThanOrEqual(10_000);
    // And it should actually have shrunk by at least the batch size.
    expect(size).toBeLessThanOrEqual(9_001);
    expect(size).toBeGreaterThan(8_000);
  });

  it("does NOT evict when the same IP is hit repeatedly under the cap", () => {
    for (let i = 0; i < 25; i += 1) {
      checkAuthorizedRequest(buildRequest({ remoteAddress: "10.0.0.1" }));
    }
    expect(__getRateLimitBucketsSize()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// WS-upgrade strict auth gate
// ---------------------------------------------------------------------------

describe("WebSocket upgrade auth", () => {
  const TRACKED = ["OCTOGENT_API_KEY", "OCTOGENT_ALLOW_REMOTE_ACCESS"] as const;
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = captureEnv(TRACKED);
    delete process.env.OCTOGENT_API_KEY;
    process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = "1";
    resetAuthState();
  });
  afterEach(() => {
    resetAuthState();
    restoreEnv(snap);
  });

  it("refuses non-loopback WS upgrade when allow-remote=1 + no API key", () => {
    const auth = checkAuthorizedWsUpgrade(
      buildRequest({ remoteAddress: "203.0.113.10" }),
    );
    expect(auth.ok).toBe(false);
    if (!auth.ok) {
      expect(auth.status).toBe(401);
      expect(auth.reason).toMatch(/WebSocket/i);
      expect(auth.reason).toMatch(/OCTOGENT_API_KEY/);
    }
  });

  it("allows loopback WS upgrade with no API key", () => {
    const auth = checkAuthorizedWsUpgrade(
      buildRequest({ remoteAddress: "127.0.0.1" }),
    );
    expect(auth.ok).toBe(true);
  });

  it("upgradeHandler destroys socket on non-loopback WS upgrade without API key", () => {
    const runtime = {
      handleUpgrade: vi.fn(() => true),
    };
    const handler = createUpgradeHandler({
      runtime: runtime as never,
      allowRemoteAccess: true,
    });
    const socket = { destroy: vi.fn() } as unknown as Socket;
    handler(
      buildRequest({
        remoteAddress: "203.0.113.10",
        url: "/api/terminals/main/ws",
        headers: {
          host: "dashboard.example.com:8787",
          origin: "https://dashboard.example.com",
        },
      }),
      socket,
      Buffer.alloc(0),
    );
    expect(runtime.handleUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Audit-log redaction
// ---------------------------------------------------------------------------

describe("audit log redaction", () => {
  const TRACKED = ["OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD"] as const;
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = captureEnv(TRACKED);
    delete process.env.OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD;
  });
  afterEach(() => {
    restoreEnv(snap);
  });

  it("redacts taskInput and rubric by default", () => {
    const entry = {
      ts: "2026-05-12T00:00:00Z",
      event: "vote-dispatched" as const,
      sessionId: "s",
      taskInput: "secret prompt body with API_KEY=abc123",
      rubric: { criteria: [{ id: "x", weight: 1, prompt: "y" }] },
    };
    const out = redactAuditEntry(entry);
    expect(out.taskInput).toMatch(/^<redacted \d+ chars>$/);
    expect(out.rubric).toMatch(/^<redacted \d+ chars>$/);
    // The placeholder must include the byte-size envelope.
    expect(out.taskInput as string).toContain(String(entry.taskInput.length));
  });

  it("preserves non-redactable fields verbatim", () => {
    const entry = {
      ts: "2026-05-12T00:00:00Z",
      event: "cap-fire" as const,
      sessionId: "s",
      providers: ["claude-code", "codex"] as ReadonlyArray<string>,
      estimatedUsd: 0.42,
      capUsd: 0.5,
      reason: "would-exceed-per-dispatch",
      taskInput: "secret",
    };
    const out = redactAuditEntry(entry);
    expect(out.ts).toBe(entry.ts);
    expect(out.event).toBe("cap-fire");
    expect(out.sessionId).toBe("s");
    expect(out.providers).toEqual(["claude-code", "codex"]);
    expect(out.estimatedUsd).toBe(0.42);
    expect(out.capUsd).toBe(0.5);
    expect(out.reason).toBe("would-exceed-per-dispatch");
    expect(out.taskInput).toMatch(/^<redacted /);
  });

  it("includes the raw payload when OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD=1", () => {
    process.env.OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD = "1";
    expect(auditPayloadIncluded()).toBe(true);
    const entry = {
      ts: "2026-05-12T00:00:00Z",
      event: "vote-dispatched" as const,
      sessionId: "s",
      taskInput: "secret prompt",
      rubric: { criteria: [{ id: "x", weight: 1, prompt: "y" }] },
    };
    const out = redactAuditEntry(entry);
    expect(out.taskInput).toBe("secret prompt");
    expect(out.rubric).toEqual({
      criteria: [{ id: "x", weight: 1, prompt: "y" }],
    });
  });

  it("end-to-end: emitAudit writes redacted JSONL by default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "octogent-audit-"));
    const path = join(dir, "audit.jsonl");
    writeFileSync(path, "");
    const prevAuditLog = process.env.OCTOGENT_AUDIT_LOG;
    const prevCap = process.env.OCTOGENT_PER_DISPATCH_USD;
    process.env.OCTOGENT_AUDIT_LOG = path;
    process.env.OCTOGENT_PER_DISPATCH_USD = "0.0000001";
    delete process.env.OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD;
    resetAuthState();

    try {
      const { handleVoteDispatchRoute } = await import(
        "../src/createApiServer/voteRoutes"
      );

      // Use the same async-generator request shape as voteRoutes.test.ts
      // so readJsonBodyOrWriteError can consume the body. Cap-fire is
      // the easiest path that emits an audit entry containing
      // taskInput: a tiny per-dispatch cap guarantees the gate trips
      // before any subprocess is spawned.
      const bodyStr = JSON.stringify({
        taskInput: "SECRET-PROMPT-marker-payload",
        taskType: "verify",
        providers: ["claude-code"],
        dryRun: true,
      });
      const stream = (async function* () {
        yield Buffer.from(bodyStr);
      })();
      const responseStub = {
        status: 0,
        body: "",
        headers: {} as Record<string, string>,
        writeHead(status: number, headers: Record<string, string>) {
          this.status = status;
          this.headers = headers;
        },
        end(chunk?: string) {
          if (chunk) this.body += chunk;
        },
        setHeader() {
          // no-op for the stub
        },
      };
      const fakeRequest = Object.assign(stream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        socket: { remoteAddress: "127.0.0.1" },
      });
      await handleVoteDispatchRoute(
        {
          request: fakeRequest as unknown as IncomingMessage,
          response: responseStub as never,
          requestUrl: new URL("http://x.test/api/claude-brain/votes/dispatch"),
          corsOrigin: null,
        } as never,
        { workspaceCwd: process.cwd() } as never,
      );

      expect(responseStub.status).toBe(402);
      const raw = readFileSync(path, "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      const capFire = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.event === "cap-fire");
      expect(capFire).toBeDefined();
      expect(raw).not.toContain("SECRET-PROMPT-marker-payload");
      expect(capFire?.taskInput).toMatch(/^<redacted /);
    } finally {
      if (prevAuditLog === undefined) delete process.env.OCTOGENT_AUDIT_LOG;
      else process.env.OCTOGENT_AUDIT_LOG = prevAuditLog;
      if (prevCap === undefined) delete process.env.OCTOGENT_PER_DISPATCH_USD;
      else process.env.OCTOGENT_PER_DISPATCH_USD = prevCap;
      resetAuthState();
    }
  });
});

// ---------------------------------------------------------------------------
// Boot-time warning wiring
// ---------------------------------------------------------------------------

describe("warnInsecureConfig — boot wiring (0.0.0.0 + no API key)", () => {
  const TRACKED = ["OCTOGENT_API_KEY", "OCTOGENT_ALLOW_REMOTE_ACCESS"] as const;
  let snap: EnvSnapshot;

  beforeEach(() => {
    snap = captureEnv(TRACKED);
    delete process.env.OCTOGENT_API_KEY;
    delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    __resetInsecureWarningLatch();
  });
  afterEach(() => {
    restoreEnv(snap);
    __resetInsecureWarningLatch();
  });

  it("0.0.0.0 bind with no API key fires the warning exactly once", () => {
    let captured = "";
    const stream = {
      write: (chunk: string) => {
        captured += chunk;
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    warnInsecureConfig("0.0.0.0", { allowRemoteAccess: false, stream });
    warnInsecureConfig("0.0.0.0", { allowRemoteAccess: false, stream });
    expect(captured).toMatch(/binding 0\.0\.0\.0/);
    // Two calls, one write — the print-once latch holds.
    expect((captured.match(/binding 0\.0\.0\.0/g) ?? []).length).toBe(1);
  });
});
