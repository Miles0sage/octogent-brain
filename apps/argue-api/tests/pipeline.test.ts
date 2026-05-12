import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPipelineScheduler, loadQueuedArgumentIds, requeueInterruptedArguments, runPipeline } from "../src/pipeline";
import { migrate, openDb, type Db } from "../src/db";

const FIXTURE = {
  url: "https://github.com/anthropics/sdk-python/pull/421",
  sha: "deadbeefcafe1234567890abcdef0123456789ab",
  title: "fix: race condition in async retry handler",
  description: "Closes #420. The previous retry logic had a race where two retries could fire simultaneously.",
  diff: "diff --git a/sdk/retry.py b/sdk/retry.py\n@@ -42,7 +42,9 @@\n-    if self.attempts < MAX:\n+    async with self._lock:\n+        if self.attempts < MAX:\n+            self.attempts += 1\n",
  ciStatus: "failure" as const,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("pipeline", () => {
  let db: Db;

  beforeEach(() => {
    process.env.ARGUED_DB_PATH = ":memory:";
    db = openDb();
    migrate(db);
  });

  it("fetches queued PR data, caches priors, gates naked verdicts, and marks run done", async () => {
    db.query(
      `INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
       VALUES (?, ?, '', '', null, '', 'none', 'queued', unixepoch())`
    ).run("abc123def456", FIXTURE.url);

    const fetchPR = vi.fn(async () => FIXTURE);
    const lookupPriors = vi.fn(async () => [
      {
        cluster_id: "retry_race",
        description: "retry race under async lock ordering",
        n_observations: 5,
        distance: 0.042,
      },
    ]);
    const dispatch = vi.fn(async (cli: string) => {
      if (cli === "claude-code") {
        return {
          cli: "claude-code" as const,
          decision: "APPROVE" as const,
          issues: [],
          reasoning: "looks good",
          cost_usd: 0,
          duration_ms: 11,
          state: "ok" as const,
        };
      }
      return {
        cli: cli as "aider" | "claude-code" | "codex" | "gemini-cli",
        decision: "REJECT" as const,
        issues: [{ severity: "high", message: "lock ordering risk", diff_lines: [42, 45] as [number, number] }],
        reasoning: `reviewed by ${cli}`,
        cost_usd: 0.02,
        duration_ms: 17,
        state: "ok" as const,
      };
    });

    const ran = await runPipeline("abc123def456", db, {
      dispatch,
      fetchPR,
      lookupPriors,
      now: () => 1_700_000_000,
    });

    expect(ran).toBe(true);
    expect(fetchPR).toHaveBeenCalledWith(FIXTURE.url);
    expect(lookupPriors).toHaveBeenCalledTimes(1);

    const argument = db
      .query("SELECT status, pr_sha, darwin_priors_json, completed_at, error_message FROM arguments WHERE id = ?")
      .get("abc123def456") as {
      status: string;
      pr_sha: string;
      darwin_priors_json: string;
      completed_at: number;
      error_message: string | null;
    };
    expect(argument.status).toBe("done");
    expect(argument.pr_sha).toBe(FIXTURE.sha);
    expect(argument.completed_at).toBe(1_700_000_000);
    expect(argument.error_message).toBeNull();
    expect(JSON.parse(argument.darwin_priors_json)).toHaveLength(1);

    const verdicts = db
      .query("SELECT cli, decision, gate_pass FROM verdicts WHERE argument_id = ? ORDER BY cli")
      .all("abc123def456") as Array<{ cli: string; decision: string; gate_pass: number }>;
    expect(verdicts).toHaveLength(4);
    expect(verdicts.find((verdict) => verdict.cli === "claude-code")?.decision).toBe("GATE_FAILED");
    expect(verdicts.filter((verdict) => verdict.gate_pass === 1)).toHaveLength(3);

    const cached = db
      .query("SELECT priors_json FROM oracle_cache WHERE diff_hash IS NOT NULL")
      .all() as Array<{ priors_json: string }>;
    expect(cached).toHaveLength(1);

    db.query("UPDATE arguments SET status = 'queued' WHERE id = ?").run("abc123def456");
    const fetchAgain = vi.fn(async () => FIXTURE);
    const lookupAgain = vi.fn(async () => {
      throw new Error("cache should satisfy second run");
    });
    await runPipeline("abc123def456", db, {
      dispatch,
      fetchPR: fetchAgain,
      lookupPriors: lookupAgain,
      now: () => 1_700_000_001,
    });
    expect(fetchAgain).not.toHaveBeenCalled();
    expect(lookupAgain).not.toHaveBeenCalled();
  });

  it("stores parse and transport failures distinctly", async () => {
    db.query(
      `INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
       VALUES (?, ?, '', '', null, '', 'none', 'queued', unixepoch())`
    ).run("abc123def460", FIXTURE.url);

    const ran = await runPipeline("abc123def460", db, {
      fetchPR: vi.fn(async () => FIXTURE),
      lookupPriors: vi.fn(async () => []),
      dispatch: vi.fn(async (cli: string) => {
        if (cli === "codex") {
          return {
            cli: "codex" as const,
            decision: null,
            issues: [{ severity: "error", message: "parse failed" }],
            reasoning: "parse failure",
            cost_usd: 0,
            duration_ms: 12,
            state: "parse_failed" as const,
          };
        }
        if (cli === "gemini-cli") {
          return {
            cli: "gemini-cli" as const,
            decision: null,
            issues: [{ severity: "error", message: "timed out" }],
            reasoning: "transport failure",
            cost_usd: 0,
            duration_ms: 15,
            state: "transport_failed" as const,
          };
        }
        return {
          cli: cli as "aider" | "claude-code",
          decision: "REJECT" as const,
          issues: [{ severity: "high", message: "risk", diff_lines: [1, 2] as [number, number] }],
          reasoning: "ok",
          cost_usd: 0,
          duration_ms: 1,
          state: "ok" as const,
        };
      }),
      now: () => 1_700_000_150,
    });

    expect(ran).toBe(true);
    const verdicts = db
      .query("SELECT cli, decision FROM verdicts WHERE argument_id = ? ORDER BY cli")
      .all("abc123def460") as Array<{ cli: string; decision: string }>;
    expect(verdicts).toContainEqual({ cli: "codex", decision: "PARSE_FAILED" });
    expect(verdicts).toContainEqual({ cli: "gemini-cli", decision: "TRANSPORT_FAILED" });
  });

  it("persists verdicts incrementally while the run is still active", async () => {
    db.query(
      `INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
       VALUES (?, ?, '', '', null, '', 'none', 'queued', unixepoch())`
    ).run("abc123def461", FIXTURE.url);

    const aiderVerdict = deferred<any>();
    const claudeVerdict = deferred<any>();
    const codexVerdict = deferred<any>();
    const geminiVerdict = deferred<any>();

    const dispatch = vi.fn((cli: string) => {
      switch (cli) {
        case "aider":
          return aiderVerdict.promise;
        case "claude-code":
          return claudeVerdict.promise;
        case "codex":
          return codexVerdict.promise;
        case "gemini-cli":
          return geminiVerdict.promise;
        default:
          throw new Error(`unexpected cli ${cli}`);
      }
    });

    const runPromise = runPipeline("abc123def461", db, {
      dispatch,
      fetchPR: vi.fn(async () => FIXTURE),
      lookupPriors: vi.fn(async () => []),
      now: () => 1_700_000_175,
    });

    claudeVerdict.resolve({
      cli: "claude-code",
      decision: "REJECT",
      issues: [{ severity: "high", message: "race", diff_lines: [1, 2] as [number, number] }],
      reasoning: "caught it",
      cost_usd: 0,
      duration_ms: 5,
      state: "ok",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const midStatus = db
      .query("SELECT status FROM arguments WHERE id = ?")
      .get("abc123def461") as { status: string };
    const midVerdicts = db
      .query("SELECT cli, decision FROM verdicts WHERE argument_id = ? ORDER BY cli")
      .all("abc123def461") as Array<{ cli: string; decision: string }>;

    expect(midStatus.status).toBe("running");
    expect(midVerdicts).toEqual([{ cli: "claude-code", decision: "REJECT" }]);

    aiderVerdict.resolve({
      cli: "aider",
      decision: "REJECT",
      issues: [{ severity: "high", message: "risk", diff_lines: [1, 2] as [number, number] }],
      reasoning: "ok",
      cost_usd: 0,
      duration_ms: 1,
      state: "ok",
    });
    codexVerdict.resolve({
      cli: "codex",
      decision: null,
      issues: [{ severity: "error", message: "parse failed" }],
      reasoning: "parse failure",
      cost_usd: 0,
      duration_ms: 2,
      state: "parse_failed",
    });
    geminiVerdict.resolve({
      cli: "gemini-cli",
      decision: null,
      issues: [{ severity: "error", message: "timed out" }],
      reasoning: "transport failure",
      cost_usd: 0,
      duration_ms: 3,
      state: "transport_failed",
    });

    await expect(runPromise).resolves.toBe(true);
  });

  it("marks the argument as error when fetch fails", async () => {
    db.query(
      `INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
       VALUES (?, ?, '', '', null, '', 'none', 'queued', unixepoch())`
    ).run("abc123def457", FIXTURE.url);

    const ran = await runPipeline("abc123def457", db, {
      fetchPR: vi.fn(async () => {
        throw new Error("github rate limit");
      }),
      now: () => 1_700_000_100,
    });

    expect(ran).toBe(false);
    const row = db
      .query("SELECT status, error_message, completed_at FROM arguments WHERE id = ?")
      .get("abc123def457") as { status: string; error_message: string; completed_at: number };
    expect(row.status).toBe("error");
    expect(row.error_message).toMatch(/github rate limit/);
    expect(row.completed_at).toBe(1_700_000_100);
  });

  it("requeues interrupted jobs and schedules all queued ids", async () => {
    db.query(
      `INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
       VALUES
         ('abc123def458', ?, '', '', null, '', 'none', 'running', unixepoch()),
         ('abc123def459', ?, '', '', null, '', 'none', 'queued', unixepoch())`
    ).run(FIXTURE.url, `${FIXTURE.url}?variant=2`);

    expect(requeueInterruptedArguments(db)).toBe(1);
    expect(loadQueuedArgumentIds(db)).toEqual(["abc123def458", "abc123def459"]);

    const scheduler = createPipelineScheduler(db, {
      dispatch: vi.fn(async (cli: string) => ({
        cli: cli as "aider" | "claude-code" | "codex" | "gemini-cli",
        decision: "REJECT" as const,
        issues: [{ severity: "high", message: "risk", diff_lines: [1, 2] as [number, number] }],
        reasoning: "ok",
        cost_usd: 0,
        duration_ms: 1,
        state: "ok" as const,
      })),
      fetchPR: vi.fn(async (url: string) => ({
        ...FIXTURE,
        url,
        sha: url.endsWith("variant=2") ? `${FIXTURE.sha}22` : `${FIXTURE.sha}11`,
      })),
      lookupPriors: vi.fn(async () => []),
      now: () => 1_700_000_200,
    });

    scheduler.resumePending();
    await scheduler.waitForIdle();

    const statuses = db.query("SELECT id, status FROM arguments ORDER BY id").all() as Array<{ id: string; status: string }>;
    expect(statuses).toEqual([
      { id: "abc123def458", status: "done" },
      { id: "abc123def459", status: "done" },
    ]);
  });
});
