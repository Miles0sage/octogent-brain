import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  handleClaudeBrainAgentTeamsRoute,
  handleClaudeBrainDpoRecentRoute,
  handleClaudeBrainReviewFixtureItemRoute,
  handleClaudeBrainReviewFixturesListRoute,
  handleClaudeBrainReviewGateRoute,
} from "../src/createApiServer/claudeBrainRoutes";

type ResponseLike = {
  status: number;
  body: string;
  headers: Record<string, string>;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
};

const buildResponse = (): ResponseLike => {
  return {
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
  };
};

// L3 audit r3 P0 (2026-05-12): each handler now calls
// checkAuthorizedRequest, which reads request.socket.remoteAddress. The
// suite runs with no OCTOGENT_API_KEY set, so requests appear to
// originate from loopback (127.0.0.1) and the gate passes through.
const buildRequest = (url: string) => {
  const response = buildResponse();
  return {
    request: {
      method: "GET",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

describe("claude-brain dpo-recent route", () => {
  let prevRoot: string | undefined;
  let workDir: string;

  beforeEach(() => {
    prevRoot = process.env.CLAUDE_BRAIN_ROOT;
    workDir = mkdtempSync(join(tmpdir(), "octogent-cb-test-"));
    process.env.CLAUDE_BRAIN_ROOT = workDir;
  });

  afterEach(() => {
    if (prevRoot === undefined) {
      delete process.env.CLAUDE_BRAIN_ROOT;
    } else {
      process.env.CLAUDE_BRAIN_ROOT = prevRoot;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns a note when dpo-pairs/ is missing", async () => {
    const ctx = buildRequest("http://x.test/api/claude-brain/dpo-recent");
    const handled = await handleClaudeBrainDpoRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      files: unknown[];
      total_pairs: number;
      note?: string;
    };
    expect(body.files).toEqual([]);
    expect(body.total_pairs).toBe(0);
    expect(body.note).toBeDefined();
  });

  it("counts lines in recent jsonl files and ignores stale ones", async () => {
    const dpoDir = join(workDir, "dpo-pairs");
    mkdirSync(dpoDir, { recursive: true });
    const today = "2026-05-06.jsonl";
    writeFileSync(join(dpoDir, today), "a\nb\nc\n");
    // Stale file: backdate mtime to 30 days ago.
    const stalePath = join(dpoDir, "2026-04-01.jsonl");
    writeFileSync(stalePath, "x\ny\n");
    const staleTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // Use fs.utimesSync to backdate.
    const { utimesSync } = await import("node:fs");
    utimesSync(stalePath, staleTime, staleTime);

    const ctx = buildRequest("http://x.test/api/claude-brain/dpo-recent?days=7");
    const handled = await handleClaudeBrainDpoRecentRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      files: Array<{ date: string | null; line_count: number }>;
      total_pairs: number;
    };
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.date).toBe("2026-05-06");
    expect(body.files[0]?.line_count).toBe(3);
    expect(body.total_pairs).toBe(3);
  });
});

// --- Agent teams + tasks ------------------------------------------------
//
// Mirrors Anthropic's experimental agent-teams persistence shape:
//   ~/.claude/teams/<team>/inboxes/<teammate>.json   (mailbox messages)
//   ~/.claude/tasks/<session-id>/.highwatermark      (per-session task offset)
//   ~/.claude/tasks/<session-id>/.lock               (task-claim lock file)

type AgentTeamsBody = {
  teams: Array<{
    name: string;
    total_messages: number;
    total_unread: number;
    last_activity_iso: string | null;
    inboxes: Array<{
      teammate: string;
      message_count: number;
      unread_count: number;
      last_timestamp_iso: string | null;
      path: string;
    }>;
  }>;
  tasks: Array<{
    session_id: string;
    size_bytes: number;
    modified_iso: string;
    has_lock: boolean;
    highwatermark: string | null;
  }>;
  source_paths: { teams_dir: string; tasks_dir: string };
  checked_at: string;
  note?: string;
};

describe("claude-brain agent-teams route", () => {
  let prevUserRoot: string | undefined;
  let userRoot: string;

  beforeEach(() => {
    prevUserRoot = process.env.CLAUDE_USER_ROOT;
    userRoot = mkdtempSync(join(tmpdir(), "octogent-cb-teams-test-"));
    process.env.CLAUDE_USER_ROOT = userRoot;
  });

  afterEach(() => {
    if (prevUserRoot === undefined) {
      delete process.env.CLAUDE_USER_ROOT;
    } else {
      process.env.CLAUDE_USER_ROOT = prevUserRoot;
    }
    rmSync(userRoot, { recursive: true, force: true });
  });

  it("returns notes when teams/ and tasks/ directories are missing", async () => {
    const ctx = buildRequest("http://x.test/api/claude-brain/agent-teams");
    const handled = await handleClaudeBrainAgentTeamsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as AgentTeamsBody;
    expect(body.teams).toEqual([]);
    expect(body.tasks).toEqual([]);
    expect(body.note).toBeDefined();
    expect(body.note).toMatch(/teams directory not found/);
    expect(body.note).toMatch(/tasks directory not found/);
  });

  it("aggregates inbox message + unread counts per team", async () => {
    const inboxDir = join(userRoot, "teams", "default", "inboxes");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(
      join(inboxDir, "researcher.json"),
      JSON.stringify([
        {
          from: "team-lead",
          text: "Start the research",
          summary: "kickoff",
          timestamp: "2026-05-10T10:00:00.000Z",
          read: false,
        },
        {
          from: "researcher",
          text: "Done",
          timestamp: "2026-05-10T12:00:00.000Z",
          read: true,
        },
      ]),
    );
    writeFileSync(
      join(inboxDir, "builder.json"),
      JSON.stringify([
        {
          from: "team-lead",
          text: "Build it",
          timestamp: "2026-05-11T09:00:00.000Z",
          read: false,
        },
      ]),
    );

    const ctx = buildRequest("http://x.test/api/claude-brain/agent-teams");
    const handled = await handleClaudeBrainAgentTeamsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as AgentTeamsBody;
    expect(body.teams).toHaveLength(1);
    const team = body.teams[0]!;
    expect(team.name).toBe("default");
    expect(team.total_messages).toBe(3);
    expect(team.total_unread).toBe(2);
    expect(team.last_activity_iso).toBe("2026-05-11T09:00:00.000Z");
    expect(team.inboxes).toHaveLength(2);
    const teammates = team.inboxes.map((inbox) => inbox.teammate).sort();
    expect(teammates).toEqual(["builder", "researcher"]);
  });

  it("captures task highwatermark + lock state per session", async () => {
    const sessionDir = join(userRoot, "tasks", "abc-123");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, ".highwatermark"), "42\n");
    writeFileSync(join(sessionDir, ".lock"), "");

    const sessionDirNoLock = join(userRoot, "tasks", "def-456");
    mkdirSync(sessionDirNoLock, { recursive: true });
    writeFileSync(join(sessionDirNoLock, ".highwatermark"), "7\n");

    const ctx = buildRequest("http://x.test/api/claude-brain/agent-teams");
    const handled = await handleClaudeBrainAgentTeamsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as AgentTeamsBody;
    expect(body.tasks).toHaveLength(2);
    const locked = body.tasks.find((task) => task.session_id === "abc-123");
    const unlocked = body.tasks.find((task) => task.session_id === "def-456");
    expect(locked?.has_lock).toBe(true);
    expect(locked?.highwatermark).toBe("42");
    expect(unlocked?.has_lock).toBe(false);
    expect(unlocked?.highwatermark).toBe("7");
  });

  it("tolerates malformed inbox JSON without throwing", async () => {
    const inboxDir = join(userRoot, "teams", "broken", "inboxes");
    mkdirSync(inboxDir, { recursive: true });
    writeFileSync(join(inboxDir, "bad.json"), "{ this is not valid json");
    writeFileSync(
      join(inboxDir, "missing-fields.json"),
      JSON.stringify([{ from: "x" }]),
    );

    const ctx = buildRequest("http://x.test/api/claude-brain/agent-teams");
    const handled = await handleClaudeBrainAgentTeamsRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as AgentTeamsBody;
    expect(body.teams).toHaveLength(1);
    const team = body.teams[0]!;
    expect(team.total_messages).toBe(0);
    expect(team.inboxes.every((inbox) => inbox.message_count === 0)).toBe(true);
  });

  it("returns 405 on non-GET method", async () => {
    const ctx = buildRequest("http://x.test/api/claude-brain/agent-teams");
    const postCtx = {
      ...ctx,
      request: {
        method: "POST",
        headers: {},
        socket: { remoteAddress: "127.0.0.1" },
      } as unknown as import("node:http").IncomingMessage,
    };
    const handled = await handleClaudeBrainAgentTeamsRoute(postCtx, {} as never);
    expect(handled).toBe(true);
    expect(postCtx.responseStub.status).toBe(405);
  });
});

// --- Review-gate playground ----------------------------------------------
//
// Fixtures live on disk so the dashboard can demo verdict-gate + decideNext
// against pre-recorded reviewer outputs (rubber-stamp, missing-JSON, clean-pass)
// without spawning a live `claude -p` subprocess.

const writeFixture = (
  dir: string,
  name: string,
  raw: string,
): void => {
  const fixture = {
    name,
    label: `${name} label`,
    description: `${name} description`,
    raw_reviewer_output: raw,
    prior_iterations: [],
    expected_outcome: {
      parsed_verdict: true,
      gate_passes: true,
      loop_action: "approve",
    },
  };
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture));
};

describe("claude-brain review-fixtures + review-gate routes", () => {
  let prevFixtures: string | undefined;
  let fixturesDir: string;

  beforeEach(() => {
    prevFixtures = process.env.OCTOGENT_FIXTURES_ROOT;
    fixturesDir = mkdtempSync(join(tmpdir(), "octogent-rg-test-"));
    process.env.OCTOGENT_FIXTURES_ROOT = fixturesDir;
  });

  afterEach(() => {
    if (prevFixtures === undefined) {
      delete process.env.OCTOGENT_FIXTURES_ROOT;
    } else {
      process.env.OCTOGENT_FIXTURES_ROOT = prevFixtures;
    }
    rmSync(fixturesDir, { recursive: true, force: true });
  });

  it("lists all fixtures, sorted by name", async () => {
    writeFixture(fixturesDir, "zeta", "{}");
    writeFixture(fixturesDir, "alpha", "{}");
    const ctx = buildRequest("http://x.test/api/claude-brain/review-fixtures");
    const handled = await handleClaudeBrainReviewFixturesListRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      fixtures: Array<{ name: string }>;
      source_path: string;
    };
    expect(body.fixtures.map((f) => f.name)).toEqual(["alpha", "zeta"]);
    expect(body.source_path).toBe(fixturesDir);
  });

  it("returns 404 for unknown fixture", async () => {
    const ctx = buildRequest(
      "http://x.test/api/claude-brain/review-fixtures/nonexistent",
    );
    const handled = await handleClaudeBrainReviewFixtureItemRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(404);
  });

  it("returns fixture detail when found", async () => {
    writeFixture(fixturesDir, "demo", '{"verdict":"pass"}');
    const ctx = buildRequest("http://x.test/api/claude-brain/review-fixtures/demo");
    const handled = await handleClaudeBrainReviewFixtureItemRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as { name: string };
    expect(body.name).toBe("demo");
  });

  const buildPostRequest = (url: string, body: unknown): ReturnType<typeof buildRequest> => {
    const ctx = buildRequest(url);
    const bodyStr = JSON.stringify(body);
    const chunks = [Buffer.from(bodyStr)];
    const stream = (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
    // L3 audit r3 P0 (2026-05-12): include socket on the POST request
    // so the new checkAuthorizedRequest gate sees loopback (no key
    // configured in this suite, so loopback default = pass-through).
    const fakeRequest = Object.assign(stream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    return {
      ...ctx,
      request: fakeRequest as unknown as import("node:http").IncomingMessage,
    };
  };

  it("parses + accepts a clean-pass verdict", async () => {
    const raw =
      'preamble\n{"verdict": "pass", "improvements_exhausted": false, "issues": [], "scores": {"groundedness": 0.94, "specificity": 0.91}}';
    const ctx = buildPostRequest(
      "http://x.test/api/claude-brain/review-gate",
      { raw_reviewer_output: raw, prior_iterations: [] },
    );
    const handled = await handleClaudeBrainReviewGateRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      parsed_verdict: { verdict: string } | null;
      gate_decision: { passes: boolean } | null;
      loop_decision: { action: string };
    };
    expect(body.parsed_verdict?.verdict).toBe("pass");
    expect(body.gate_decision?.passes).toBe(true);
    expect(body.loop_decision.action).toBe("approve");
  });

  it("rejects rubber-stamp verdict where scores fall below threshold", async () => {
    const raw =
      '{"verdict": "pass", "improvements_exhausted": false, "issues": [], "scores": {"groundedness": 0.62, "specificity": 0.88}}';
    const ctx = buildPostRequest(
      "http://x.test/api/claude-brain/review-gate",
      { raw_reviewer_output: raw, prior_iterations: [] },
    );
    const handled = await handleClaudeBrainReviewGateRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      parsed_verdict: { verdict: string } | null;
      gate_decision: { passes: boolean } | null;
      loop_decision: { action: string };
    };
    expect(body.parsed_verdict?.verdict).toBe("pass");
    expect(body.gate_decision?.passes).toBe(false);
    expect(body.loop_decision.action).toBe("continue");
  });

  it("returns null parsed_verdict when JSON is missing", async () => {
    const raw = "prose only — reviewer forgot the JSON tail";
    const ctx = buildPostRequest(
      "http://x.test/api/claude-brain/review-gate",
      { raw_reviewer_output: raw, prior_iterations: [] },
    );
    const handled = await handleClaudeBrainReviewGateRoute(ctx, {} as never);
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      parsed_verdict: unknown;
      gate_decision: unknown;
      loop_decision: { action: string };
    };
    expect(body.parsed_verdict).toBeNull();
    expect(body.gate_decision).toBeNull();
    // No verdict parsed -> no iteration appended -> empty iterations -> "continue".
    expect(body.loop_decision.action).toBe("continue");
  });

  it("returns 405 on GET to /review-gate", async () => {
    const ctx = buildRequest("http://x.test/api/claude-brain/review-gate");
    const handled = await handleClaudeBrainReviewGateRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(405);
  });
});
