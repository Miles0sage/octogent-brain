// L3 audit r3 P0 (2026-05-12): close the read-only /api/claude-brain/*
// auth gap. Lane B finalized the WS upgrade + bucket eviction + audit
// redaction tracks, but the 10 read-only handlers in claudeBrainRoutes.ts
// and trajectoryRoutes.ts never called checkAuthorizedRequest. Under
// OCTOGENT_ALLOW_REMOTE_ACCESS=1 (single-user dev VPS escape hatch) they
// leaked host state — systemd daemon list, ~/.claude/agent-memory layout,
// DPO clusters, BriefingDeck rollouts, fixture playground — to any
// non-loopback caller without any credential check.
//
// This suite gates every read-only handler on the same C1 contract used
// by voteRoutes.ts / driverRoutes.ts:
//   - OCTOGENT_API_KEY set + no bearer / wrong bearer → 401
//   - OCTOGENT_API_KEY set + valid bearer → 200 (happy path)
//   - OCTOGENT_API_KEY unset + loopback → 200 (backward-compat: dashboards
//     boot on 127.0.0.1 by default and must keep working without any key)
//   - OCTOGENT_API_KEY unset + OCTOGENT_ALLOW_REMOTE_ACCESS unset +
//     non-loopback → 401 (direct closure of the reviewer's P0)
//
// The 7 handlers in claudeBrainRoutes.ts + 3 in trajectoryRoutes.ts get
// one auth-shape test each. Two extra regressions pin backward-compat
// (loopback no-key 200) and the P0 itself (remote no-key 401 on
// /daemons). Total: 12 new tests.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleClaudeBrainAgentTeamsRoute,
  handleClaudeBrainDaemonsRoute,
  handleClaudeBrainDpoRecentRoute,
  handleClaudeBrainMemoryRoute,
  handleClaudeBrainReviewFixtureItemRoute,
  handleClaudeBrainReviewFixturesListRoute,
  handleClaudeBrainReviewGateRoute,
} from "../src/createApiServer/claudeBrainRoutes";
import {
  handleClaudeBrainRewardsRecentRoute,
  handleClaudeBrainRolloutItemRoute,
  handleClaudeBrainRolloutsRoute,
} from "../src/createApiServer/trajectoryRoutes";

type ResponseLike = {
  status: number;
  body: string;
  headers: Record<string, string>;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
};

const buildResponse = (): ResponseLike => ({
  status: 0,
  body: "",
  headers: {},
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  },
  end(body) {
    this.body = body ?? "";
  },
});

// Mirrors the shape used by voteRoutes.test.ts. Tests that need to drive
// a request from a non-loopback IP override remoteAddress.
const buildGet = (
  url: string,
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
) => {
  const response = buildResponse();
  const fakeRequest = {
    method: "GET",
    headers: options.headers ?? {},
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  };
  return {
    request: fakeRequest as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

const buildPost = (
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
) => {
  const response = buildResponse();
  const bodyStr = JSON.stringify(body);
  const stream = (async function* () {
    yield Buffer.from(bodyStr);
  })();
  const fakeRequest = Object.assign(stream, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  });
  return {
    request: fakeRequest as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

const TEST_KEY = "test-secret-cb-auth";

// Shared env-snapshot harness: every test in this file runs with a clean
// OCTOGENT_API_KEY / OCTOGENT_ALLOW_REMOTE_ACCESS pair so cases don't
// leak into one another. resetAuthState() drops the per-IP rate-limit
// bucket map so 30-req loops in unrelated suites don't trip the 429 path.
describe("claude-brain read-only routes: C1 auth gate", () => {
  let prevKey: string | undefined;
  let prevAllowRemote: string | undefined;
  let prevBrainRoot: string | undefined;
  let prevUserRoot: string | undefined;
  let prevFixtures: string | undefined;
  let workDir: string;

  beforeEach(async () => {
    prevKey = process.env.OCTOGENT_API_KEY;
    prevAllowRemote = process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    prevBrainRoot = process.env.CLAUDE_BRAIN_ROOT;
    prevUserRoot = process.env.CLAUDE_USER_ROOT;
    prevFixtures = process.env.OCTOGENT_FIXTURES_ROOT;
    delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    process.env.OCTOGENT_API_KEY = TEST_KEY;
    workDir = mkdtempSync(join(tmpdir(), "octogent-cb-auth-"));
    process.env.CLAUDE_BRAIN_ROOT = workDir;
    process.env.CLAUDE_USER_ROOT = workDir;
    process.env.OCTOGENT_FIXTURES_ROOT = join(workDir, "fixtures");
    const { resetAuthState } = await import("../src/createApiServer/security");
    resetAuthState();
  });

  afterEach(async () => {
    if (prevKey === undefined) {
      delete process.env.OCTOGENT_API_KEY;
    } else {
      process.env.OCTOGENT_API_KEY = prevKey;
    }
    if (prevAllowRemote === undefined) {
      delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    } else {
      process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = prevAllowRemote;
    }
    if (prevBrainRoot === undefined) {
      delete process.env.CLAUDE_BRAIN_ROOT;
    } else {
      process.env.CLAUDE_BRAIN_ROOT = prevBrainRoot;
    }
    if (prevUserRoot === undefined) {
      delete process.env.CLAUDE_USER_ROOT;
    } else {
      process.env.CLAUDE_USER_ROOT = prevUserRoot;
    }
    if (prevFixtures === undefined) {
      delete process.env.OCTOGENT_FIXTURES_ROOT;
    } else {
      process.env.OCTOGENT_FIXTURES_ROOT = prevFixtures;
    }
    rmSync(workDir, { recursive: true, force: true });
    const { resetAuthState } = await import("../src/createApiServer/security");
    resetAuthState();
  });

  // ---- /api/claude-brain/daemons ----------------------------------------

  it("GET /daemons without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/daemons");
    const handled = await handleClaudeBrainDaemonsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
    const body = JSON.parse(ctx.responseStub.body) as { error: string };
    expect(typeof body.error).toBe("string");
  });

  it("GET /daemons with valid bearer returns 200", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/daemons", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainDaemonsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/dpo-recent -------------------------------------

  it("GET /dpo-recent without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/dpo-recent");
    const handled = await handleClaudeBrainDpoRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /dpo-recent with valid bearer returns 200", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/dpo-recent", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainDpoRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/memory -----------------------------------------

  it("GET /memory without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/memory");
    const handled = await handleClaudeBrainMemoryRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /memory with valid bearer returns 200", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/memory", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainMemoryRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/agent-teams ------------------------------------

  it("GET /agent-teams without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/agent-teams");
    const handled = await handleClaudeBrainAgentTeamsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /agent-teams with valid bearer returns 200", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/agent-teams", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainAgentTeamsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/review-fixtures (list) -------------------------

  it("GET /review-fixtures without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/review-fixtures");
    const handled = await handleClaudeBrainReviewFixturesListRoute(
      ctx,
      {} as never,
    );
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /review-fixtures with valid bearer returns 200", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/review-fixtures", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainReviewFixturesListRoute(
      ctx,
      {} as never,
    );
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/review-fixtures/:name --------------------------

  it("GET /review-fixtures/:name without bearer returns 401", async () => {
    // The route returns 404 for unknown fixtures; the auth gate must fire
    // BEFORE the fixture lookup so the unauthenticated caller cannot
    // probe fixture-name existence via the 401 vs 404 differential.
    mkdirSync(join(workDir, "fixtures"), { recursive: true });
    writeFileSync(
      join(workDir, "fixtures", "demo.json"),
      JSON.stringify({
        name: "demo",
        label: "demo",
        description: "demo",
        raw_reviewer_output: "{}",
        prior_iterations: [],
        expected_outcome: {
          parsed_verdict: true,
          gate_passes: true,
          loop_action: "approve",
        },
      }),
    );
    const ctx = buildGet("http://x.test/api/claude-brain/review-fixtures/demo");
    const handled = await handleClaudeBrainReviewFixtureItemRoute(
      ctx,
      {} as never,
    );
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /review-fixtures/:name with valid bearer returns 200", async () => {
    mkdirSync(join(workDir, "fixtures"), { recursive: true });
    writeFileSync(
      join(workDir, "fixtures", "demo.json"),
      JSON.stringify({
        name: "demo",
        label: "demo",
        description: "demo",
        raw_reviewer_output: "{}",
        prior_iterations: [],
        expected_outcome: {
          parsed_verdict: true,
          gate_passes: true,
          loop_action: "approve",
        },
      }),
    );
    const ctx = buildGet(
      "http://x.test/api/claude-brain/review-fixtures/demo",
      { headers: { authorization: `Bearer ${TEST_KEY}` } },
    );
    const handled = await handleClaudeBrainReviewFixtureItemRoute(
      ctx,
      {} as never,
    );
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/review-gate (POST) -----------------------------

  it("POST /review-gate without bearer returns 401", async () => {
    const ctx = buildPost(
      "http://x.test/api/claude-brain/review-gate",
      { raw_reviewer_output: "{}", prior_iterations: [] },
    );
    const handled = await handleClaudeBrainReviewGateRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("POST /review-gate with valid bearer returns 200", async () => {
    const ctx = buildPost(
      "http://x.test/api/claude-brain/review-gate",
      { raw_reviewer_output: "no JSON", prior_iterations: [] },
      { headers: { authorization: `Bearer ${TEST_KEY}` } },
    );
    const handled = await handleClaudeBrainReviewGateRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/rollouts ---------------------------------------

  it("GET /rollouts without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/rollouts");
    const handled = await handleClaudeBrainRolloutsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /rollouts with valid bearer returns 200", async () => {
    // BriefingDeck SQLite db is absent on a fresh tmpdir; the route
    // returns 200 + note (not 404) when the db doesn't exist. Pin that
    // contract so the auth-gate test doesn't accidentally couple to db
    // availability on the host.
    const ctx = buildGet("http://x.test/api/claude-brain/rollouts", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainRolloutsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  // ---- /api/claude-brain/rollouts/:id -----------------------------------

  it("GET /rollouts/:id without bearer returns 401", async () => {
    const ctx = buildGet(
      "http://x.test/api/claude-brain/rollouts/some-rollout-id",
    );
    const handled = await handleClaudeBrainRolloutItemRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /rollouts/:id with valid bearer returns 200 or 404 (auth fires first)", async () => {
    // Without a BriefingDeck db on the test host the route answers 404
    // "rollout store not available". The acceptance contract here is
    // simply "not 401" — auth passed and the handler reached its
    // db-lookup branch.
    const ctx = buildGet(
      "http://x.test/api/claude-brain/rollouts/some-rollout-id",
      { headers: { authorization: `Bearer ${TEST_KEY}` } },
    );
    const handled = await handleClaudeBrainRolloutItemRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).not.toBe(401);
  });

  // ---- /api/claude-brain/rewards/recent ---------------------------------

  it("GET /rewards/recent without bearer returns 401", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/rewards/recent");
    const handled = await handleClaudeBrainRewardsRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("GET /rewards/recent with valid bearer returns 200", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/rewards/recent", {
      headers: { authorization: `Bearer ${TEST_KEY}` },
    });
    const handled = await handleClaudeBrainRewardsRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });
});

// Two regression tests that pin the two ends of the contract:
//   (1) operators on loopback with no API key keep getting their data —
//       the dashboard's default boot mode must not break.
//   (2) the reviewer's P0 scenario itself (remote caller + no key +
//       OCTOGENT_ALLOW_REMOTE_ACCESS NOT set) is hard-refused on
//       /daemons. This is the regression that proves the gate was
//       wired in the right place.
describe("claude-brain read-only routes: regression — backward compat + P0 closure", () => {
  let prevKey: string | undefined;
  let prevAllowRemote: string | undefined;

  beforeEach(async () => {
    prevKey = process.env.OCTOGENT_API_KEY;
    prevAllowRemote = process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    delete process.env.OCTOGENT_API_KEY;
    delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    const { resetAuthState } = await import("../src/createApiServer/security");
    resetAuthState();
  });

  afterEach(async () => {
    if (prevKey === undefined) {
      delete process.env.OCTOGENT_API_KEY;
    } else {
      process.env.OCTOGENT_API_KEY = prevKey;
    }
    if (prevAllowRemote === undefined) {
      delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    } else {
      process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = prevAllowRemote;
    }
    const { resetAuthState } = await import("../src/createApiServer/security");
    resetAuthState();
  });

  it("loopback access still works without OCTOGENT_API_KEY for read routes", async () => {
    // 127.0.0.1 + no key: the strict default lets loopback through.
    // Dashboards boot on loopback by default, so this is the contract
    // that keeps the local-dev experience unchanged.
    const ctx = buildGet("http://x.test/api/claude-brain/daemons", {
      remoteAddress: "127.0.0.1",
    });
    const handled = await handleClaudeBrainDaemonsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("remote caller without OCTOGENT_API_KEY and without OCTOGENT_ALLOW_REMOTE_ACCESS returns 401 on /daemons", async () => {
    // Direct closure of the reviewer's P0: with no key set and the
    // single-user dev-VPS escape hatch not enabled, a request from a
    // non-loopback IP must be refused. Before this fix, the handler
    // returned 200 + the full daemon list — that's the leak.
    const ctx = buildGet("http://x.test/api/claude-brain/daemons", {
      remoteAddress: "203.0.113.42",
    });
    const handled = await handleClaudeBrainDaemonsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });
});
