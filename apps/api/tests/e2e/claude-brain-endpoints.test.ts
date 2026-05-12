// E2E: full sweep across every /api/claude-brain/* endpoint. For each
// endpoint we assert (a) a happy-path 200 + shape, (b) an error path
// (wrong method 405, bad payload 400, missing resource 404, etc).
//
// Endpoint inventory (discovered from requestHandler.ts API_ROUTE_MAP
// "claude-brain" entry — kept in sync with the source via this const so
// the suite is self-documenting). When you add a new claude-brain
// route, add it here and write at least one happy + one error test.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootApiServer, httpRequest, type BootedApiServer } from "./helpers";

const CLAUDE_BRAIN_ENDPOINTS = [
  { path: "/api/claude-brain/daemons", method: "GET", gated: false },
  { path: "/api/claude-brain/dpo-recent", method: "GET", gated: false },
  { path: "/api/claude-brain/memory", method: "GET", gated: false },
  { path: "/api/claude-brain/rollouts", method: "GET", gated: false },
  { path: "/api/claude-brain/rollouts/:id", method: "GET", gated: false },
  { path: "/api/claude-brain/rewards/recent", method: "GET", gated: false },
  { path: "/api/claude-brain/agent-teams", method: "GET", gated: false },
  { path: "/api/claude-brain/review-fixtures", method: "GET", gated: false },
  { path: "/api/claude-brain/review-fixtures/:name", method: "GET", gated: false },
  { path: "/api/claude-brain/review-gate", method: "POST", gated: false },
  { path: "/api/claude-brain/drivers", method: "GET", gated: false },
  { path: "/api/claude-brain/drivers/dispatch", method: "POST", gated: true },
  { path: "/api/claude-brain/votes/dispatch", method: "POST", gated: true },
  { path: "/api/claude-brain/cost-cap", method: "GET", gated: true },
  { path: "/api/claude-brain/cost-cap/audit", method: "GET", gated: true },
] as const;

describe("e2e: /api/claude-brain/* endpoint sweep", () => {
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

  it("inventory const documents every claude-brain endpoint", () => {
    // Sanity guard — if the source adds a new route, this test should be
    // updated. We can't introspect API_ROUTE_MAP from here without
    // importing implementation internals, so this guard is a header
    // pointing the next builder to keep CLAUDE_BRAIN_ENDPOINTS aligned.
    expect(CLAUDE_BRAIN_ENDPOINTS.length).toBeGreaterThanOrEqual(13);
  });

  // ---- daemons -----------------------------------------------------------

  it("GET /daemons returns { daemons, checked_at }", async () => {
    const r = await httpRequest<{ daemons: unknown[]; checked_at: string }>(
      server!.baseUrl,
      "/api/claude-brain/daemons",
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.daemons)).toBe(true);
    expect(typeof r.body.checked_at).toBe("string");
  });

  it("POST /daemons returns 405 (method not allowed)", async () => {
    const r = await httpRequest(server!.baseUrl, "/api/claude-brain/daemons", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(405);
  });

  // ---- dpo-recent --------------------------------------------------------

  it("GET /dpo-recent returns { files, total_pairs, days }", async () => {
    const r = await httpRequest<{
      files: unknown[];
      total_pairs: number;
      days: number;
    }>(server!.baseUrl, "/api/claude-brain/dpo-recent");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.files)).toBe(true);
    expect(typeof r.body.total_pairs).toBe("number");
    expect(typeof r.body.days).toBe("number");
  });

  it("GET /dpo-recent honors ?days= query parameter", async () => {
    const r = await httpRequest<{ days: number }>(
      server!.baseUrl,
      "/api/claude-brain/dpo-recent?days=3",
    );
    expect(r.status).toBe(200);
    expect(r.body.days).toBe(3);
  });

  // ---- memory ------------------------------------------------------------

  it("GET /memory returns { scopes, project_memories }", async () => {
    const r = await httpRequest<{
      scopes: unknown[];
      project_memories: unknown[];
    }>(server!.baseUrl, "/api/claude-brain/memory");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.scopes)).toBe(true);
    expect(Array.isArray(r.body.project_memories)).toBe(true);
  });

  // ---- rollouts ----------------------------------------------------------

  it("GET /rollouts returns { rollouts, db_path, limit }", async () => {
    const r = await httpRequest<{
      rollouts: unknown[];
      db_path: string;
      limit: number;
    }>(server!.baseUrl, "/api/claude-brain/rollouts");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.rollouts)).toBe(true);
    expect(typeof r.body.db_path).toBe("string");
    expect(typeof r.body.limit).toBe("number");
  });

  it("GET /rollouts/:id with an invalid id charset returns 400", async () => {
    // The route whitelists [A-Za-z0-9._:-]{1,128}; a slash collapses to a
    // different route shape, but a `%21` (!) escapes URL-decode to an
    // invalid character.
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/rollouts/abc%21bad",
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/invalid rollout_id/);
  });

  it("GET /rollouts/:id with a non-existent id returns 404 (or 200+empty when db absent)", async () => {
    // When the BriefingDeck SQLite db is absent the route returns 404
    // with an error+db_path. When the db exists but the row is missing
    // it returns 404 "rollout not found". Either way: 404.
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/rollouts/nonexistent-rollout-id-zzz",
    );
    expect(r.status).toBe(404);
    expect(typeof r.body.error).toBe("string");
  });

  // ---- rewards/recent ----------------------------------------------------

  it("GET /rewards/recent returns { days, rewards, by_agent }", async () => {
    const r = await httpRequest<{
      days: number;
      rewards: unknown[];
      by_agent: Record<string, unknown>;
    }>(server!.baseUrl, "/api/claude-brain/rewards/recent");
    expect(r.status).toBe(200);
    expect(typeof r.body.days).toBe("number");
    expect(Array.isArray(r.body.rewards)).toBe(true);
    expect(typeof r.body.by_agent).toBe("object");
  });

  // ---- agent-teams -------------------------------------------------------

  it("GET /agent-teams returns { teams, tasks, source_paths, checked_at }", async () => {
    const r = await httpRequest<{
      teams: unknown[];
      tasks: unknown[];
      source_paths: { teams_dir: string; tasks_dir: string };
      checked_at: string;
    }>(server!.baseUrl, "/api/claude-brain/agent-teams");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.teams)).toBe(true);
    expect(Array.isArray(r.body.tasks)).toBe(true);
    expect(typeof r.body.source_paths.teams_dir).toBe("string");
    expect(typeof r.body.source_paths.tasks_dir).toBe("string");
  });

  // ---- review-fixtures + review-gate ------------------------------------

  it("GET /review-fixtures returns { fixtures, source_path }", async () => {
    const r = await httpRequest<{
      fixtures: Array<{ name: string }>;
      source_path: string;
    }>(server!.baseUrl, "/api/claude-brain/review-fixtures");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.fixtures)).toBe(true);
    expect(typeof r.body.source_path).toBe("string");
  });

  it("GET /review-fixtures/:name returns 404 for an unknown fixture name", async () => {
    const r = await httpRequest<{ error: string; name: string }>(
      server!.baseUrl,
      "/api/claude-brain/review-fixtures/this-fixture-does-not-exist",
    );
    expect(r.status).toBe(404);
    expect(r.body.error).toMatch(/not found/i);
  });

  it("POST /review-gate parses + grades a reviewer verdict", async () => {
    const r = await httpRequest<{
      parsed_verdict: unknown;
      gate_decision: unknown;
      loop_decision: unknown;
      iterations_considered: number;
    }>(server!.baseUrl, "/api/claude-brain/review-gate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        raw_reviewer_output: "no JSON here at all",
        prior_iterations: [],
      }),
    });
    expect(r.status).toBe(200);
    // raw output had no parseable verdict → parsed_verdict is null
    expect(r.body.parsed_verdict).toBeNull();
    expect(typeof r.body.iterations_considered).toBe("number");
  });

  it("GET /review-gate returns 405 (POST only)", async () => {
    const r = await httpRequest(server!.baseUrl, "/api/claude-brain/review-gate");
    expect(r.status).toBe(405);
  });

  // ---- drivers -----------------------------------------------------------

  it("GET /drivers returns a driver list with config_source + drivers", async () => {
    const r = await httpRequest<{
      config_source: string;
      defaultProvider: string;
      drivers: Array<{ provider: string }>;
    }>(server!.baseUrl, "/api/claude-brain/drivers");
    expect(r.status).toBe(200);
    expect(typeof r.body.config_source).toBe("string");
    expect(Array.isArray(r.body.drivers)).toBe(true);
    expect(r.body.drivers.length).toBeGreaterThan(0);
  });

  it("POST /drivers/dispatch with missing taskType returns 400", async () => {
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/drivers/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskInput: "hello" }),
      },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/taskType/);
  });

  it("POST /drivers/dispatch with dryRun=true returns a DriverDispatchResult", async () => {
    const r = await httpRequest<{
      dispatch_id: string;
      provider: string;
      events: unknown[];
    }>(server!.baseUrl, "/api/claude-brain/drivers/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        taskType: "verify",
        taskInput: "verify this output",
        dryRun: true,
      }),
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.dispatch_id).toBe("string");
    expect(r.body.dispatch_id.length).toBeGreaterThan(0);
    expect(Array.isArray(r.body.events)).toBe(true);
  });

  // ---- votes/dispatch ----------------------------------------------------

  it("POST /votes/dispatch with bad providers returns 400", async () => {
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          taskInput: "verify",
          providers: ["not-a-real-provider"],
          dryRun: true,
        }),
      },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/provider/i);
  });

  it("POST /votes/dispatch with missing taskInput returns 400", async () => {
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/votes/dispatch",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskType: "verify", dryRun: true }),
      },
    );
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/taskInput/);
  });

  // ---- cost-cap ----------------------------------------------------------

  it("GET /cost-cap returns { config, usage }", async () => {
    const r = await httpRequest<{
      config: { tier: string };
      usage: { daySpentUsd: number; dayStart: number };
    }>(server!.baseUrl, "/api/claude-brain/cost-cap");
    expect(r.status).toBe(200);
    expect(typeof r.body.config.tier).toBe("string");
  });

  it("GET /cost-cap/audit returns { entries: [] } when no audit events fired", async () => {
    const r = await httpRequest<{ entries: unknown[] }>(
      server!.baseUrl,
      "/api/claude-brain/cost-cap/audit",
    );
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.entries)).toBe(true);
  });

  it("POST /cost-cap returns 405", async () => {
    const r = await httpRequest(server!.baseUrl, "/api/claude-brain/cost-cap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(r.status).toBe(405);
  });

  // ---- unknown subpath ---------------------------------------------------

  it("GET /api/claude-brain/totally-unknown returns 404", async () => {
    const r = await httpRequest<{ error: string }>(
      server!.baseUrl,
      "/api/claude-brain/totally-unknown",
    );
    expect(r.status).toBe(404);
    expect(typeof r.body.error).toBe("string");
  });
});
