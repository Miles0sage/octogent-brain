// E2E: bearer-token auth gate + per-IP rate limit on the gated
// /api/claude-brain/* routes. These tests boot a server with
// OCTOGENT_API_KEY=test-secret-key and assert that the middleware
// rejects/accepts correctly across the four credential surfaces
// (no header, valid Bearer, X-Octogent-Token, query token) plus the
// 30 req/min cap.
//
// Equivalent unit-level tests exist in voteRoutes.test.ts +
// drivers.test.ts. The e2e variants here additionally prove the wire
// path: a real http.Server, a real socket address read by the auth
// helper, real header propagation through node:http.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootApiServer, httpRequest, type BootedApiServer } from "./helpers";

const TEST_KEY = "test-secret-key-e2e";

describe("e2e: auth gate (OCTOGENT_API_KEY enforcement)", () => {
  let server: BootedApiServer | null = null;

  beforeEach(async () => {
    server = await bootApiServer({
      env: {
        OCTOGENT_API_KEY: TEST_KEY,
        OCTOGENT_ALLOW_REMOTE_ACCESS: null,
      },
    });
    const { resetAuthState } = await import("../../src/createApiServer/security");
    resetAuthState();
    const { resetCostCapState } = await import("../../src/cost-cap");
    resetCostCapState();
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    const { resetAuthState } = await import("../../src/createApiServer/security");
    resetAuthState();
    const { resetCostCapState } = await import("../../src/cost-cap");
    resetCostCapState();
  });

  it("POST /votes/dispatch without bearer returns 401", async () => {
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    expect(r.status).toBe(401);
    expect(r.body.error).toMatch(/bearer/i);
  });

  it("POST /votes/dispatch with wrong Bearer returns 401", async () => {
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer the-wrong-key",
        },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    expect(r.status).toBe(401);
  });

  it("POST /votes/dispatch with valid Bearer returns 200", async () => {
    const r = await httpRequest<{ vote_id: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_KEY}`,
        },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.vote_id).toBe("string");
  });

  it("POST /votes/dispatch with X-Octogent-Token header returns 200", async () => {
    const r = await httpRequest<{ vote_id: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octogent-token": TEST_KEY,
        },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.vote_id).toBe("string");
  });

  it("POST /votes/dispatch ignores ?octogent_token (header-only on POST)", async () => {
    // The query-token path is intentionally NOT enabled by default on
    // POST routes — checkAuthorizedRequest only honors it when the route
    // passes allowQueryToken=true (cost-cap status uses this; votes
    // dispatch does not). This test pins that contract.
    const r = await httpRequest(
      server!.baseUrl,
      `/api/claude-brain/votes/dispatch?octogent_token=${TEST_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    // Today checkAuthorizedRequest only reads bearer headers when
    // called without options. votes/dispatch passes no options →
    // query token is ignored → 401.
    expect(r.status).toBe(401);
  });

  it("POST /drivers/dispatch without bearer returns 401", async () => {
    const r = await httpRequest(
      server!.baseUrl,
      "/api/claude-brain/drivers/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskType: "verify",
          taskInput: "hi",
          dryRun: true,
        }),
      },
    );
    expect(r.status).toBe(401);
  });

  it("POST /drivers/dispatch with valid Bearer returns 200", async () => {
    const r = await httpRequest<{ dispatch_id: string }>(
      server!.baseUrl,
      "/api/claude-brain/drivers/dispatch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_KEY}`,
        },
        body: JSON.stringify({
          taskType: "verify",
          taskInput: "hi",
          dryRun: true,
        }),
      },
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.dispatch_id).toBe("string");
  });

  it("GET /cost-cap without auth returns 401", async () => {
    const r = await httpRequest(server!.baseUrl, "/api/claude-brain/cost-cap");
    expect(r.status).toBe(401);
  });

  it("GET /cost-cap with valid Bearer returns 200", async () => {
    const r = await httpRequest<{ config: unknown }>(
      server!.baseUrl,
      "/api/claude-brain/cost-cap",
      {
        headers: { authorization: `Bearer ${TEST_KEY}` },
      },
    );
    expect(r.status).toBe(200);
    expect(r.body.config).toBeDefined();
  });

  it("GET /cost-cap/audit without auth returns 401", async () => {
    const r = await httpRequest(
      server!.baseUrl,
      "/api/claude-brain/cost-cap/audit",
    );
    expect(r.status).toBe(401);
  });

  it("GET /cost-cap/audit with valid Bearer returns 200 + entries[]", async () => {
    const r = await httpRequest<{ entries: unknown[] }>(
      server!.baseUrl,
      "/api/claude-brain/cost-cap/audit",
      {
        headers: { authorization: `Bearer ${TEST_KEY}` },
      },
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.entries)).toBe(true);
  });

  it("/api/claude-brain/daemons IS auth-gated (P0 closure) — 401 without bearer, 200 with", async () => {
    // L3 audit r3 P0 (2026-05-12): the read-only daemons handler
    // previously bypassed the auth gate. Under
    // OCTOGENT_ALLOW_REMOTE_ACCESS=1 with no API key this leaked the
    // systemd daemon list to every non-loopback caller. Lane-A's
    // original assertion (200 without bearer) pinned the *bug*; this
    // updated assertion pins the *fix*. Other read-only handlers
    // (memory, agent-teams, rollouts, rewards, …) share the same
    // contract and are covered by tests/claudeBrainAuth.test.ts.
    const daemonsUnauth = await httpRequest(
      server!.baseUrl,
      "/api/claude-brain/daemons",
    );
    expect(daemonsUnauth.status).toBe(401);
    const daemonsAuth = await httpRequest(
      server!.baseUrl,
      "/api/claude-brain/daemons",
      { headers: { authorization: `Bearer ${TEST_KEY}` } },
    );
    expect(daemonsAuth.status).toBe(200);
  });

  it("/api/claude-brain/drivers GET stays ungated (read-only driver list, no host state)", async () => {
    // driverRoutes.ts gates /drivers/dispatch (state-changing) but
    // intentionally leaves the GET list ungated — it's static driver
    // metadata, not host telemetry. This test pins that asymmetry so a
    // future scope-creep change doesn't accidentally close it.
    const drivers = await httpRequest(server!.baseUrl, "/api/claude-brain/drivers");
    expect(drivers.status).toBe(200);
  });

  it("31st request in <60s on /votes/dispatch returns 429 (rate limit)", async () => {
    // Per-IP bucket = 30/min. Fire 30 valid requests, then a 31st must
    // come back 429.
    for (let i = 0; i < 30; i++) {
      const r = await httpRequest(
        server!.baseUrl,
        "/api/claude-brain/votes/dispatch",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TEST_KEY}`,
          },
          body: JSON.stringify({ taskInput: "verify", dryRun: true }),
        },
      );
      expect(r.status).toBe(200);
    }
    const overflow = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${TEST_KEY}`,
        },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    expect(overflow.status).toBe(429);
    expect(overflow.body.error).toMatch(/rate limit/i);
  });
});

describe("e2e: auth gate (loopback default when OCTOGENT_API_KEY unset)", () => {
  let server: BootedApiServer | null = null;

  beforeEach(async () => {
    server = await bootApiServer({
      env: {
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

  it("loopback POST /votes/dispatch with no key set returns 200 (dev-VPS default)", async () => {
    const r = await httpRequest<{ vote_id: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskInput: "verify", dryRun: true }),
      },
    );
    expect(r.status).toBe(200);
    expect(typeof r.body.vote_id).toBe("string");
  });

  it("loopback GET /cost-cap with no key set returns 200", async () => {
    const r = await httpRequest<{ config: unknown }>(
      server!.baseUrl,
      "/api/claude-brain/cost-cap",
    );
    expect(r.status).toBe(200);
    expect(r.body.config).toBeDefined();
  });
});
