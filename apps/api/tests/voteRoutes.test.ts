// API surface for the cross-vendor voting primitive. The route fan-outs the
// task to every healthy evaluator driver in parallel via dispatchTask,
// extracts each verdict, and tallies via the pure tallyVotes function from
// @octogent/supervisor. The HTTP layer is the only place where I/O happens.

import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "@octogent/core";
import { describe, expect, it } from "vitest";

import { handleVoteDispatchRoute } from "../src/createApiServer/voteRoutes";

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

const buildPost = (url: string, body: unknown) => {
  const response = buildResponse();
  const bodyStr = JSON.stringify(body);
  const stream = (async function* () {
    yield Buffer.from(bodyStr);
  })();
  const fakeRequest = Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return {
    request: fakeRequest as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

describe("voteRoutes — request validation", () => {
  it("returns 405 on GET", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/votes/dispatch");
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(405);
  });

  it("returns 400 on missing taskInput", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {});
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
    const body = JSON.parse(ctx.responseStub.body) as { error: string };
    expect(body.error).toMatch(/taskInput/);
  });

  it("returns 400 when body is not a JSON object", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", "not-an-object");
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("does not match other paths (returns false to fall through to next handler)", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/other", {
      taskInput: "x",
    });
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
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
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
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
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
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
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
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
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
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
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      dispatch_ids: string[];
      outcome: { verdicts: unknown[] };
    };
    expect(body.dispatch_ids.length).toBe(body.outcome.verdicts.length);
    expect(body.dispatch_ids.length).toBe(2);
  });
});

// Suppress unused-import lints (kept for type-narrowing when we extend the
// test surface with custom configs in a follow-up).
type _ConfigRef = RoutingConfig;
void ({} as _ConfigRef);
void DEFAULT_ROUTING_CONFIG;
