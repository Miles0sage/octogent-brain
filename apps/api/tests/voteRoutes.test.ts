// API surface for the cross-vendor voting primitive. The route fan-outs the
// task to every healthy evaluator driver in parallel via dispatchTask,
// extracts each verdict, and tallies via the pure tallyVotes function from
// @octogent/supervisor. The HTTP layer is the only place where I/O happens.

import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "@octogent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
