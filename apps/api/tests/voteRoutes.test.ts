// API surface for the cross-vendor voting primitive. The route fan-outs the
// task to every healthy evaluator driver in parallel via dispatchTask,
// extracts each verdict, and tallies via the pure tallyVotes function from
// @octogent/supervisor. The HTTP layer is the only place where I/O happens.

import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "@octogent/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleVoteDispatchRoute } from "../src/createApiServer/voteRoutes";

// CMA wave 1b (2026-05-12): partial-mock @octogent/supervisor so the
// rubric-injection test surface can capture the augmented taskInput that
// gets passed into dispatchTask and synthesize voter stdout containing
// `CmaGradeResult` JSON. `dispatchTask` defaults to passthrough so the
// pre-existing 26 tests in this file (which rely on dryRun=true on the
// real dispatcher) keep working without changes.
const { mockDispatchTask, realSupervisor } = vi.hoisted(() => ({
  mockDispatchTask: vi.fn(),
  // Holder for the real module reference so we can install the
  // passthrough default after vi.importActual resolves.
  realSupervisor: { ref: null as unknown },
}));
vi.mock("@octogent/supervisor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@octogent/supervisor")>();
  realSupervisor.ref = actual;
  // Explicitly enumerate exports so the partial-mock namespace exposes
  // every original symbol the test surface imports (vitest module
  // namespaces don't always iterate via spread when consumers
  // destructure named imports).
  return {
    DEFAULT_VOTE_CONFIG: actual.DEFAULT_VOTE_CONFIG,
    tallyVotes: actual.tallyVotes,
    loadRoutingConfig: actual.loadRoutingConfig,
    dispatchTask: mockDispatchTask,
    buildCmaPromptInjection: actual.buildCmaPromptInjection,
    cmaGradeToReviewerVerdict: actual.cmaGradeToReviewerVerdict,
    isCmaRubric: actual.isCmaRubric,
    isCmaGradeResult: actual.isCmaGradeResult,
    parseCmaGradeFromText: actual.parseCmaGradeFromText,
  };
});

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

const buildGet = (url: string) => {
  const response = buildResponse();
  return {
    request: { method: "GET" } as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

const buildPost = (
  url: string,
  body: unknown,
  options: {
    headers?: Record<string, string>;
    remoteAddress?: string;
  } = {},
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

const buildRouteDeps = (workspaceCwd = process.cwd()) => ({ workspaceCwd } as never);

// Global passthrough: every test starts with dispatchTask delegating to
// the real implementation. CMA tests below override this with
// mockImplementationOnce / mockImplementation to capture args + inject
// synthetic stdout for the rubric-injection contract.
beforeEach(() => {
  const actual = realSupervisor.ref as
    | typeof import("@octogent/supervisor")
    | null;
  if (actual !== null) {
    mockDispatchTask.mockImplementation((...args) =>
      actual.dispatchTask(...(args as Parameters<typeof actual.dispatchTask>)),
    );
  }
});

describe("voteRoutes — request validation", () => {
  it("returns 405 on GET", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/votes/dispatch");
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(405);
  });

  it("returns 400 on missing taskInput", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {});
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
    const body = JSON.parse(ctx.responseStub.body) as { error: string };
    expect(body.error).toMatch(/taskInput/);
  });

  it("returns 400 when body is not a JSON object", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", "not-an-object");
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("does not match other paths (returns false to fall through to next handler)", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/other", {
      taskInput: "x",
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(false);
  });
});

describe("voteRoutes — dryRun fan-out", () => {
  it("dryRun=true returns a vote outcome + per-provider dispatch_ids without spawning", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify this diff is grounded in the source files",
      taskType: "verify",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      vote_id: string;
      outcome: { winner: string; verdicts: Array<{ provider: string }> };
      dispatch_ids: string[];
      started_at_iso: string;
      duration_ms: number;
    };
    expect(typeof body.vote_id).toBe("string");
    expect(body.vote_id.length).toBeGreaterThan(0);
    expect(typeof body.started_at_iso).toBe("string");
    expect(typeof body.duration_ms).toBe("number");
    expect(Array.isArray(body.dispatch_ids)).toBe(true);
    expect(Array.isArray(body.outcome.verdicts)).toBe(true);
    // Outcome shape: must include winner field.
    expect(["pass", "fail", "no-consensus"]).toContain(body.outcome.winner);
  });

  it("default providers list = all evaluator-capable healthy drivers when omitted", async () => {
    // We don't assume host-availability of every CLI. The route should:
    //   (a) load routing config (DEFAULT_ROUTING_CONFIG when no file)
    //   (b) pick drivers whose capabilities include "evaluator" or "all"
    //   (c) dispatch each in parallel
    // From DEFAULT_ROUTING_CONFIG: claude-code (evaluator+all), codex
    // (evaluator). aider is writer-only, gemini-cli is intel-only — neither
    // should appear in the verdicts list.
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "check this output is grounded",
      taskType: "verify",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      outcome: { verdicts: Array<{ provider: string }> };
    };
    const providersDispatched = body.outcome.verdicts.map((v) => v.provider);
    // claude-code MUST be in the dispatch list — it's evaluator-capable.
    expect(providersDispatched).toContain("claude-code");
    // codex MUST be in the dispatch list — its capabilities include evaluator.
    expect(providersDispatched).toContain("codex");
    // aider (writer-only) MUST NOT be in the dispatch list.
    expect(providersDispatched).not.toContain("aider");
    // gemini-cli (intel-only) MUST NOT be in the dispatch list.
    expect(providersDispatched).not.toContain("gemini-cli");
  });

  it("respects an explicit providers list when provided", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      outcome: { verdicts: Array<{ provider: string }> };
    };
    expect(body.outcome.verdicts.map((v) => v.provider)).toEqual(["claude-code"]);
  });
});

describe("voteRoutes — outcome shape contract", () => {
  it("outcome always carries winner/reason/consensus_count/dissent_count/verdicts fields", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      outcome: {
        winner: string;
        reason: string;
        consensus_count: number;
        dissent_count: number;
        verdicts: unknown[];
      };
    };
    expect(typeof body.outcome.winner).toBe("string");
    expect(typeof body.outcome.reason).toBe("string");
    expect(typeof body.outcome.consensus_count).toBe("number");
    expect(typeof body.outcome.dissent_count).toBe("number");
    expect(Array.isArray(body.outcome.verdicts)).toBe(true);
  });

  it("dispatch_ids length matches verdicts length (one dispatch per voter)", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code", "codex"],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      dispatch_ids: string[];
      outcome: { verdicts: unknown[] };
    };
    expect(body.dispatch_ids.length).toBe(body.outcome.verdicts.length);
    expect(body.dispatch_ids.length).toBe(2);
  });
});

// L3 audit r2 H3 (2026-05-12): vote dispatch fan-out hardening.
//
// Background: voteRoutes previously accepted any providers list length
// and ran `Promise.all` across the full set. Combined with the (now
// closed) auth gap, that gave an attacker a textbook amplification DoS
// — one HTTP POST could spawn arbitrary N subprocesses. Additionally,
// one voter throwing synchronously inside its dispatch path rejected
// the whole tally via Promise.all rather than producing an isolated
// error voter. Fix:
//   - MAX_VOTERS = 8 cap on `providers` array (and default selection)
//   - Dedup providers via Set before fan-out
//   - Promise.allSettled per voter so an exception in one voter does
//     not poison the whole vote — the voter gets an `error` field and
//     the rest still tally.
describe("voteRoutes H3: fan-out cap + dedup + per-voter try/catch", () => {
  it("rejects 9-voter requests with HTTP 400 (MAX_VOTERS=8)", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      // 9 entries — over the cap. Repeats are fine; the cap fires on
      // length before dedup.
      providers: [
        "claude-code",
        "codex",
        "aider",
        "gemini-cli",
        "claude-code",
        "codex",
        "aider",
        "gemini-cli",
        "claude-code",
      ],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
    const body = JSON.parse(ctx.responseStub.body) as { error: string };
    expect(body.error).toMatch(/providers/i);
  });

  it("dedups duplicate providers before fan-out", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      // Three duplicates of claude-code — must collapse to one voter.
      providers: ["claude-code", "claude-code", "claude-code"],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      dispatch_ids: string[];
      outcome: { verdicts: Array<{ provider: string }> };
    };
    expect(body.outcome.verdicts).toHaveLength(1);
    expect(body.outcome.verdicts[0]?.provider).toBe("claude-code");
    expect(body.dispatch_ids).toHaveLength(1);
  });

  it("rejects empty providers array with HTTP 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: [],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("caps the default (no providers field) fan-out at MAX_VOTERS=8", async () => {
    // DEFAULT_ROUTING_CONFIG only has 2 evaluator-capable drivers today,
    // so this asserts the cap is in effect rather than the exact length.
    // (When the cap kicks in for a real >8-driver config, the slice keeps
    // the first 8 — the cap behaviour is exercised here defensively.)
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      outcome: { verdicts: unknown[] };
    };
    expect(body.outcome.verdicts.length).toBeLessThanOrEqual(8);
  });
});

// L3 audit r2 C1 (2026-05-12): bearer-token auth + per-IP rate limit on
// /votes/dispatch (and /drivers/dispatch — covered by drivers.test.ts).
//
// Threat model:
//   - When OCTOGENT_API_KEY is unset, only loopback IPs may hit the
//     endpoint; LAN access is refused with 401.
//   - When OCTOGENT_API_KEY is set, every request must present a valid
//     bearer token (Authorization header or X-Octogent-Token). Wrong
//     or missing token → 401.
//   - 30 req/min per IP — exceeding → 429. The bucket is per-IP and
//     in-memory; we reset between tests via resetAuthState().
describe("voteRoutes C1: bearer-token auth + per-IP rate limit", () => {
  let prevKey: string | undefined;
  let prevAllowRemote: string | undefined;
  beforeEach(async () => {
    prevKey = process.env.OCTOGENT_API_KEY;
    prevAllowRemote = process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    // Tests in this block exercise the strict default (loopback-only
    // when no key is set). The OCTOGENT_ALLOW_REMOTE_ACCESS=1 escape
    // hatch for single-user dev VPS is a separate concern.
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

  it("refuses LAN access with 401 when OCTOGENT_API_KEY is unset", async () => {
    delete process.env.OCTOGENT_API_KEY;
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      { remoteAddress: "192.168.1.42" },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("allows LAN access when OCTOGENT_ALLOW_REMOTE_ACCESS=1 (single-user dev VPS escape hatch)", async () => {
    delete process.env.OCTOGENT_API_KEY;
    process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = "1";
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      { remoteAddress: "192.168.1.42" },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("allows loopback access with 200 when OCTOGENT_API_KEY is unset", async () => {
    delete process.env.OCTOGENT_API_KEY;
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      { remoteAddress: "127.0.0.1" },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("refuses with 401 when API key is set but no Authorization header is sent", async () => {
    process.env.OCTOGENT_API_KEY = "test-secret-12345";
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      { remoteAddress: "127.0.0.1" },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("refuses with 401 when bearer token is wrong", async () => {
    process.env.OCTOGENT_API_KEY = "test-secret-12345";
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      {
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer wrong-key" },
      },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(401);
  });

  it("accepts with 200 when bearer token matches", async () => {
    process.env.OCTOGENT_API_KEY = "test-secret-12345";
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      {
        remoteAddress: "127.0.0.1",
        headers: { authorization: "Bearer test-secret-12345" },
      },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("accepts with 200 when X-Octogent-Token header is used", async () => {
    process.env.OCTOGENT_API_KEY = "test-secret-12345";
    const ctx = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      {
        remoteAddress: "127.0.0.1",
        headers: { "x-octogent-token": "test-secret-12345" },
      },
    );
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("returns 429 when the per-IP rate limit is exceeded", async () => {
    delete process.env.OCTOGENT_API_KEY;
    const remoteAddress = "127.0.0.1";
    // The bucket allows 30 / minute. Fire 31 requests in a tight loop;
    // the 31st must come back 429.
    for (let i = 0; i < 30; i++) {
      const ctx = buildPost(
        "http://x.test/api/claude-brain/votes/dispatch",
        { taskInput: "verify", dryRun: true },
        { remoteAddress },
      );
      const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
      expect(handled).toBe(true);
      expect(ctx.responseStub.status).toBe(200);
    }
    const overflow = buildPost(
      "http://x.test/api/claude-brain/votes/dispatch",
      { taskInput: "verify", dryRun: true },
      { remoteAddress },
    );
    const handled = await handleVoteDispatchRoute(overflow, buildRouteDeps());
    expect(handled).toBe(true);
    expect(overflow.responseStub.status).toBe(429);
  });
});

// Suppress unused-import lints (kept for type-narrowing when we extend the
// test surface with custom configs in a follow-up).
type _ConfigRef = RoutingConfig;
void ({} as _ConfigRef);
void DEFAULT_ROUTING_CONFIG;

// Lane-3 cost-cap UX wave 2 — pre-flight cap refusal, audit log emission,
// /cost-cap status route. Tests cover the 4 contract points in the spec:
//   - 402 (Payment Required) when per-dispatch cap would be exceeded
//   - recordSpend called after a voter completes (visible via /cost-cap)
//   - cap-fire audit-log line written when blocked
//   - GET /cost-cap returns { config, usage }
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("voteRoutes cost-cap — pre-flight enforcement + audit log", () => {
  let prevDispatchEnv: string | undefined;
  let prevAuditEnv: string | undefined;
  let prevAllowRemote: string | undefined;
  let tmpDir: string;
  let auditPath: string;

  beforeEach(async () => {
    prevDispatchEnv = process.env.OCTOGENT_PER_DISPATCH_USD;
    prevAuditEnv = process.env.OCTOGENT_AUDIT_LOG;
    prevAllowRemote = process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    tmpDir = mkdtempSync(join(tmpdir(), "octogent-cap-"));
    auditPath = join(tmpDir, "audit.jsonl");
    process.env.OCTOGENT_AUDIT_LOG = auditPath;
    const { resetCostCapState } = await import("../src/cost-cap");
    resetCostCapState();
    const { resetAuthState } = await import("../src/createApiServer/security");
    resetAuthState();
  });

  afterEach(async () => {
    if (prevDispatchEnv === undefined) delete process.env.OCTOGENT_PER_DISPATCH_USD;
    else process.env.OCTOGENT_PER_DISPATCH_USD = prevDispatchEnv;
    if (prevAuditEnv === undefined) delete process.env.OCTOGENT_AUDIT_LOG;
    else process.env.OCTOGENT_AUDIT_LOG = prevAuditEnv;
    if (prevAllowRemote === undefined) delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    else process.env.OCTOGENT_ALLOW_REMOTE_ACCESS = prevAllowRemote;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup races */
    }
    const { resetCostCapState } = await import("../src/cost-cap");
    resetCostCapState();
  });

  it("blocks dispatch with HTTP 402 when per-dispatch cap would be exceeded", async () => {
    // Tighten the per-dispatch cap so even a single dryRun voter would
    // exceed it. The estimate for claude-code at the spec input is well
    // above $0.000001 — that floor guarantees the cap fires.
    process.env.OCTOGENT_PER_DISPATCH_USD = "0.000001";
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(402);
    const body = JSON.parse(ctx.responseStub.body) as {
      ok: false;
      capError: { reason: string; capUsd: number };
    };
    expect(body.ok).toBe(false);
    expect(body.capError.reason).toBe("would-exceed-per-dispatch");
  });

  it("emits a cap-fire audit log entry when blocked", async () => {
    process.env.OCTOGENT_PER_DISPATCH_USD = "0.000001";
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      dryRun: true,
    });
    await handleVoteDispatchRoute(ctx, buildRouteDeps());
    const audit = readFileSync(auditPath, "utf8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { event: string; reason?: string });
    const capFire = audit.find((e) => e.event === "cap-fire");
    expect(capFire).toBeDefined();
    expect(capFire?.reason).toBe("would-exceed-per-dispatch");
  });

  it("records spend after each voter completes (visible via /cost-cap)", async () => {
    // Default $0.50 per-dispatch is plenty; a single dryRun voter
    // succeeds and recordSpend should fire from the route.
    const dispatchCtx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(dispatchCtx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(dispatchCtx.responseStub.status).toBe(200);

    // /api/claude-brain/cost-cap returns aggregated daily totals.
    const { handleCostCapStatusRoute } = await import(
      "../src/createApiServer/voteRoutes"
    );
    const statusCtx = buildGet("http://x.test/api/claude-brain/cost-cap");
    // Convert the GET to the GET path (replace method).
    (statusCtx.request as unknown as { method: string }).method = "GET";
    (statusCtx.request as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "127.0.0.1",
    };
    (statusCtx.request as unknown as { headers: Record<string, string> }).headers = {};
    const ok = await handleCostCapStatusRoute(statusCtx, buildRouteDeps());
    expect(ok).toBe(true);
    expect(statusCtx.responseStub.status).toBe(200);
    const status = JSON.parse(statusCtx.responseStub.body) as {
      config: { perDispatchUsd: number; tier: string };
      usage: { daySpentUsd: number };
    };
    expect(status.usage.daySpentUsd).toBeGreaterThan(0);
    expect(status.config.tier).toBe("free");
  });

  it("/api/claude-brain/cost-cap returns config + usage even with no spend", async () => {
    const { handleCostCapStatusRoute } = await import(
      "../src/createApiServer/voteRoutes"
    );
    const ctx = buildGet("http://x.test/api/claude-brain/cost-cap");
    (ctx.request as unknown as { method: string }).method = "GET";
    (ctx.request as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "127.0.0.1",
    };
    (ctx.request as unknown as { headers: Record<string, string> }).headers = {};
    const handled = await handleCostCapStatusRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const status = JSON.parse(ctx.responseStub.body) as {
      config: { perDispatchUsd: number; perSessionUsd: number; perDayUsd: number; tier: string };
      usage: { daySpentUsd: number };
    };
    expect(status.config.perDispatchUsd).toBe(0.5);
    expect(status.config.perSessionUsd).toBe(5);
    expect(status.config.perDayUsd).toBe(20);
    expect(status.usage.daySpentUsd).toBe(0);
  });

  it("GET /api/claude-brain/cost-cap/audit returns recent audit entries", async () => {
    // Drive one successful dispatch to populate audit log.
    const dispatchCtx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      dryRun: true,
    });
    await handleVoteDispatchRoute(dispatchCtx, buildRouteDeps());

    const { handleCostCapAuditRoute } = await import(
      "../src/createApiServer/voteRoutes"
    );
    const auditCtx = buildGet("http://x.test/api/claude-brain/cost-cap/audit");
    (auditCtx.request as unknown as { method: string }).method = "GET";
    (auditCtx.request as unknown as { socket: { remoteAddress: string } }).socket = {
      remoteAddress: "127.0.0.1",
    };
    (auditCtx.request as unknown as { headers: Record<string, string> }).headers = {};
    const handled = await handleCostCapAuditRoute(auditCtx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(auditCtx.responseStub.status).toBe(200);
    const body = JSON.parse(auditCtx.responseStub.body) as {
      entries: Array<{ event: string }>;
    };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    // Should contain at least one vote-dispatched event.
    expect(body.entries.some((e) => e.event === "vote-dispatched")).toBe(true);
  });
});

// =====================================================================
// v0.2 wave 1b (2026-05-12) — CMA rubric portability wiring on the
// /votes/dispatch surface. Six tests covering:
//
//   1. valid rubric is accepted + the injection prompt is prepended to
//      each voter's taskInput (verified by capturing args to dispatchTask)
//   2. invalid rubric shape => HTTP 400 (no dispatch attempted)
//   3. when a voter emits valid CmaGradeResult JSON, the voter verdict is
//      derived from cmaGradeToReviewerVerdict (not parseReviewerVerdict)
//   4. when a rubric is supplied but the voter emits no parseable grade,
//      fall back to parseReviewerVerdict — don't fail the vote
//   5. order-of-checks: cost-cap pre-flight fires BEFORE rubric injection
//      (no dispatch / no injection when the cap trips)
//   6. order-of-checks: C1 auth fires BEFORE rubric handling (401 even
//      when rubric is well-formed)
// =====================================================================

import {
  buildCmaPromptInjection,
  cmaGradeToReviewerVerdict,
  type CmaGradeResult,
  type CmaRubric,
} from "@octogent/supervisor";

const validRubric = (): CmaRubric => ({
  rubric_id: "anthropic-cookbook-outcome-grader",
  rubric_version: "1.0.0",
  criteria: [
    { name: "grounded", description: "Cites source files", weight: 0.6 },
    { name: "concrete", description: "Uses concrete numbers", weight: 0.4 },
  ],
  passing_threshold: 0.8,
});

const validGrade = (overrides: Partial<CmaGradeResult> = {}): CmaGradeResult => ({
  criterion_scores: { grounded: 0.9, concrete: 0.85 },
  weighted_average: 0.88,
  passed: true,
  rationale: "All criteria above threshold.",
  ...overrides,
});

const synthesizeDispatchResult = (
  provider: import("@octogent/core").TerminalAgentProvider,
  stdout: string,
): Awaited<ReturnType<typeof import("@octogent/supervisor").dispatchTask>> => ({
  dispatch_id: `mock-${provider}`,
  taskType: "verify",
  invocation: {
    provider,
    command: "echo",
    args: [],
    cwd: process.cwd(),
    envFlags: [],
  },
  health: { healthy: true },
  started_at_iso: new Date().toISOString(),
  events: [{ kind: "stdout", data: stdout }],
  exit_code: 0,
  duration_ms: 0,
});

describe("voteRoutes wave-1b: CMA rubric injection contract", () => {
  beforeEach(async () => {
    delete process.env.OCTOGENT_API_KEY;
    delete process.env.OCTOGENT_ALLOW_REMOTE_ACCESS;
    const { resetAuthState } = await import("../src/createApiServer/security");
    resetAuthState();
    const { resetCostCapState } = await import("../src/cost-cap");
    resetCostCapState();
  });
  afterEach(() => {
    mockDispatchTask.mockReset();
  });

  it("accepts a valid CMA rubric in the dispatch payload and prepends the injection prompt", async () => {
    // Capture the taskInput passed to dispatchTask. We use a passthrough
    // that records the call args then returns a synthetic dry-run result
    // (avoids real subprocess + keeps tally deterministic).
    const captured: Array<{ taskInput: string; provider: string }> = [];
    mockDispatchTask.mockImplementation(async (config, request) => {
      const provider = (config.rules[0]?.preferred ?? "claude-code") as string;
      captured.push({ taskInput: request.taskInput, provider });
      return synthesizeDispatchResult(
        provider as import("@octogent/core").TerminalAgentProvider,
        "[dry-run] not spawned",
      );
    });

    const rubric = validRubric();
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify this diff",
      taskType: "verify",
      providers: ["claude-code", "codex"],
      rubric,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);

    // The injection prompt is the deterministic output of
    // buildCmaPromptInjection. Each voter's taskInput must START with
    // that prompt + then the original taskInput (separated by blank line).
    const expectedPrefix = buildCmaPromptInjection(rubric);
    expect(captured.length).toBe(2);
    for (const c of captured) {
      expect(c.taskInput.startsWith(expectedPrefix)).toBe(true);
      expect(c.taskInput).toContain("verify this diff");
    }
  });

  it("rejects an invalid CMA rubric shape with HTTP 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      // Invalid: criteria is empty.
      rubric: {
        rubric_id: "bad",
        rubric_version: "1.0.0",
        criteria: [],
        passing_threshold: 0.8,
      },
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
    const body = JSON.parse(ctx.responseStub.body) as {
      ok?: boolean;
      error: string;
    };
    expect(body.error).toMatch(/CMA rubric/i);
    // dispatchTask must NOT have fired — invalid rubric is rejected
    // before fan-out.
    expect(mockDispatchTask).not.toHaveBeenCalled();
  });

  it("transforms CMA grade response into ReviewerVerdict via cmaGradeToReviewerVerdict", async () => {
    const rubric = validRubric();
    const grade = validGrade({
      criterion_scores: { grounded: 0.95, concrete: 0.92 },
      weighted_average: 0.94,
      passed: true,
      rationale: "Strong grounding.",
    });
    // Voter stdout = preamble + final balanced JSON object (the grade).
    // parseCmaGradeFromText picks the LAST balanced JSON.
    const voterStdout = `Some preamble.\n\n${JSON.stringify(grade)}\n`;
    mockDispatchTask.mockImplementation(async (config) => {
      const provider = (config.rules[0]?.preferred ?? "claude-code") as string;
      return synthesizeDispatchResult(
        provider as import("@octogent/core").TerminalAgentProvider,
        voterStdout,
      );
    });

    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      rubric,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      outcome: {
        verdicts: Array<{
          provider: string;
          verdict: { verdict: string; scores: { groundedness: number } } | null;
        }>;
      };
    };
    const expected = cmaGradeToReviewerVerdict(grade, rubric);
    expect(body.outcome.verdicts).toHaveLength(1);
    const voter = body.outcome.verdicts[0]!;
    expect(voter.verdict).not.toBeNull();
    expect(voter.verdict?.verdict).toBe(expected.verdict);
    expect(voter.verdict?.scores.groundedness).toBeCloseTo(
      expected.scores.groundedness,
      6,
    );
  });

  it("falls back to parseReviewerVerdict when rubric supplied but voter emits no parseable grade", async () => {
    const rubric = validRubric();
    // Stdout contains a regular ReviewerVerdict JSON tail — NOT a
    // CmaGradeResult shape. parseCmaGradeFromText must return null and
    // the route must fall back to parseReviewerVerdict rather than
    // producing a null voter.
    const reviewerVerdict = {
      verdict: "pass",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.9, specificity: 0.88 },
    };
    const voterStdout = `reasoning...\n${JSON.stringify(reviewerVerdict)}\n`;
    mockDispatchTask.mockImplementation(async (config) => {
      const provider = (config.rules[0]?.preferred ?? "claude-code") as string;
      return synthesizeDispatchResult(
        provider as import("@octogent/core").TerminalAgentProvider,
        voterStdout,
      );
    });

    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify",
      taskType: "verify",
      providers: ["claude-code"],
      rubric,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      outcome: {
        verdicts: Array<{
          verdict:
            | {
                verdict: string;
                scores: { groundedness: number; specificity: number };
              }
            | null;
        }>;
      };
    };
    expect(body.outcome.verdicts).toHaveLength(1);
    const voter = body.outcome.verdicts[0]!;
    // Verdict must come from parseReviewerVerdict path, not null.
    expect(voter.verdict).not.toBeNull();
    expect(voter.verdict?.verdict).toBe("pass");
    expect(voter.verdict?.scores.groundedness).toBeCloseTo(0.9, 6);
    expect(voter.verdict?.scores.specificity).toBeCloseTo(0.88, 6);
  });

  it("rubric injection composes with cost-cap pre-flight gate (cost gate fires first)", async () => {
    const prevDispatchEnv = process.env.OCTOGENT_PER_DISPATCH_USD;
    process.env.OCTOGENT_PER_DISPATCH_USD = "0.000001";
    try {
      const { resetCostCapState } = await import("../src/cost-cap");
      resetCostCapState();
      const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
        taskInput: "verify",
        taskType: "verify",
        providers: ["claude-code"],
        rubric: validRubric(),
      });
      const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
      expect(handled).toBe(true);
      // Cap fires BEFORE any rubric work => HTTP 402, no dispatchTask call.
      expect(ctx.responseStub.status).toBe(402);
      expect(mockDispatchTask).not.toHaveBeenCalled();
    } finally {
      if (prevDispatchEnv === undefined) {
        delete process.env.OCTOGENT_PER_DISPATCH_USD;
      } else {
        process.env.OCTOGENT_PER_DISPATCH_USD = prevDispatchEnv;
      }
      const { resetCostCapState } = await import("../src/cost-cap");
      resetCostCapState();
    }
  });

  it("rubric injection composes with C1 auth gate (auth fires first)", async () => {
    const prevKey = process.env.OCTOGENT_API_KEY;
    process.env.OCTOGENT_API_KEY = "test-secret-abc";
    try {
      const { resetAuthState } = await import("../src/createApiServer/security");
      resetAuthState();
      // No Authorization header — must fail at the auth gate, never
      // reach rubric validation OR dispatch.
      const ctx = buildPost(
        "http://x.test/api/claude-brain/votes/dispatch",
        {
          taskInput: "verify",
          taskType: "verify",
          providers: ["claude-code"],
          rubric: validRubric(),
        },
        { remoteAddress: "127.0.0.1" },
      );
      const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
      expect(handled).toBe(true);
      expect(ctx.responseStub.status).toBe(401);
      expect(mockDispatchTask).not.toHaveBeenCalled();
    } finally {
      if (prevKey === undefined) {
        delete process.env.OCTOGENT_API_KEY;
      } else {
        process.env.OCTOGENT_API_KEY = prevKey;
      }
      const { resetAuthState } = await import("../src/createApiServer/security");
      resetAuthState();
    }
  });
});
