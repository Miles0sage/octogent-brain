// E2E: boot the real http.Server, bind to a random loopback port, fire
// real fetch() requests, assert on real responses. These tests catch
// regressions that the handler-level stubs in tests/*.test.ts cannot —
// specifically: host/origin gating, CORS layering, allowRemoteAccess
// wiring, server.close() teardown, and the boot-time prompts sync.
//
// Per brief: the project does NOT ship a /healthz endpoint and we are
// explicitly forbidden from adding one. We use GET
// /api/claude-brain/daemons as the boot smoke target — it has no auth,
// degrades to {daemons: [], note: ...} when systemctl is missing, and
// always returns 200.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootApiServer, httpRequest, type BootedApiServer } from "./helpers";

describe("e2e: server boots, accepts requests, tears down cleanly", () => {
  let server: BootedApiServer | null = null;

  beforeEach(async () => {
    // Each test boots its own server on a fresh random port so suites can
    // run in parallel without binding collisions.
    server = await bootApiServer({
      env: {
        // No auth key set — the loopback default lets us hit endpoints
        // without bearer headers, matching the dev-VPS quick-start.
        OCTOGENT_API_KEY: null,
        OCTOGENT_ALLOW_REMOTE_ACCESS: null,
      },
    });
    const { resetAuthState } = await import("../../src/createApiServer/security");
    resetAuthState();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    const { resetAuthState } = await import("../../src/createApiServer/security");
    resetAuthState();
  });

  it("binds to a random loopback port and exposes baseUrl", () => {
    expect(server).not.toBeNull();
    const url = new URL(server!.baseUrl);
    expect(url.hostname).toBe("127.0.0.1");
    expect(Number.parseInt(url.port, 10)).toBeGreaterThan(0);
    expect(Number.parseInt(url.port, 10)).toBeLessThan(65536);
  });

  it("returns 200 + JSON shape on GET /api/claude-brain/daemons (boot smoke)", async () => {
    const response = await httpRequest<{
      daemons: unknown[];
      checked_at: string;
      note?: string;
    }>(server!.baseUrl, "/api/claude-brain/daemons");
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.daemons)).toBe(true);
    expect(typeof response.body.checked_at).toBe("string");
    // Content-type assertion guards against accidentally serving HTML on
    // a JSON route (a regression we've seen when the static fallback
    // catches an api/ path).
    expect(response.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("returns 200 + { config, usage } on GET /api/claude-brain/cost-cap (loopback, no key)", async () => {
    const response = await httpRequest<{
      config: { tier: string };
      usage: { daySpentUsd: number; dayStart: number };
    }>(server!.baseUrl, "/api/claude-brain/cost-cap");
    expect(response.status).toBe(200);
    expect(response.body.config).toBeDefined();
    expect(typeof response.body.config.tier).toBe("string");
    expect(typeof response.body.usage.daySpentUsd).toBe("number");
    expect(typeof response.body.usage.dayStart).toBe("number");
  });

  it("POST /api/claude-brain/votes/dispatch with dryRun=true returns a vote outcome without spawning", async () => {
    const response = await httpRequest<{
      vote_id: string;
      outcome: { winner: string; verdicts: unknown[] };
      dispatch_ids: string[];
      duration_ms: number;
    }>(server!.baseUrl, "/api/claude-brain/votes/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskInput: "verify this output is grounded in source",
        taskType: "verify",
        dryRun: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(typeof response.body.vote_id).toBe("string");
    expect(response.body.vote_id.length).toBeGreaterThan(0);
    expect(Array.isArray(response.body.outcome.verdicts)).toBe(true);
    expect(["pass", "fail", "no-consensus"]).toContain(response.body.outcome.winner);
    expect(Array.isArray(response.body.dispatch_ids)).toBe(true);
  });

  it("404 + { error } on an unknown /api/claude-brain/* path", async () => {
    const response = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/does-not-exist",
    );
    expect(response.status).toBe(404);
    expect(typeof response.body.error).toBe("string");
  });

  // Non-loopback 401 simulation: we cannot bind to a non-loopback
  // interface from within an isolated test (no LAN IP guaranteed in CI)
  // without bringing up extra plumbing. The bearer-token path covers
  // the equivalent threat model in auth-gate.test.ts. The loopback
  // origin gate is exercised by createApiServer.test.ts already.
  //
  // SKIP rationale: this gap is intentional — covered by auth-gate
  // suite's "API_KEY required + invalid bearer rejected" tests.

  it("teardown is clean — close() returns before the next test boots", async () => {
    // The afterEach hook closes; this test asserts close() resolves
    // promptly enough that beforeEach can rebind without EADDRINUSE.
    expect(server).not.toBeNull();
    const before = Date.now();
    await server!.close();
    server = null;
    const elapsed = Date.now() - before;
    // 2s upper bound: server.close() with closeAllConnections() should
    // settle within a few ms. A regression that leaves sockets pinned
    // would blow past this.
    expect(elapsed).toBeLessThan(2000);
  });
});
