import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAppFetchHandler } from "../src/app";
import { migrate, openDb, type Db } from "../src/db";

describe("argue-api app routes", () => {
  let db: Db;

  beforeEach(() => {
    process.env.ARGUED_DB_PATH = ":memory:";
    db = openDb();
    migrate(db);
  });

  it("serves JSON and HTML result views", async () => {
    db.query(
      `INSERT INTO arguments (
        id,
        pr_url,
        pr_sha,
        diff_truncated,
        pr_title,
        pr_description,
        ci_status,
        darwin_priors_json,
        status,
        error_message,
        created_at,
        completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done', null, ?, ?)`
    ).run(
      "abc123def456",
      "https://github.com/acme/repo/pull/7",
      "deadbeef",
      "diff --git a/a.ts b/a.ts",
      "Fix race",
      "Tighten the lock order",
      "success",
      JSON.stringify([{ cluster_id: "retry_race", description: "retry race", n_observations: 3, distance: 0.1 }]),
      1_700_000_000,
      1_700_000_060
    );
    db.query(
      `INSERT INTO verdicts (
        argument_id,
        cli,
        decision,
        issues_json,
        reasoning,
        cost_usd,
        duration_ms,
        gate_pass
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "abc123def456",
      "claude-code",
      "REJECT",
      JSON.stringify([{ severity: "high", message: "race", diff_lines: [1, 2] }]),
      "caught the race",
      0,
      42,
      1
    );

    const fetch = createAppFetchHandler(db);

    const jsonRes = await fetch(new Request("http://localhost/api/arguments/abc123def456"));
    expect(jsonRes.status).toBe(200);
    const json = await jsonRes.json() as {
      prTitle: string;
      summary: { rejects: number; validVerdicts: number; consensus: string };
    };
    expect(json.prTitle).toBe("Fix race");
    expect(json.summary.rejects).toBe(1);
    expect(json.summary.validVerdicts).toBe(1);
    expect(json.summary.consensus).toBe("INCOMPLETE");

    const htmlRes = await fetch(new Request("http://localhost/v/abc123def456"));
    expect(htmlRes.status).toBe(200);
    const html = await htmlRes.text();
    expect(html).toContain("Four agents argued. One was lying.");
    expect(html).toContain("Fix race");
    expect(html).toContain("retry_race");
  });

  it("queues POST /argue through the onQueued callback", async () => {
    const onQueued = vi.fn();
    const fetch = createAppFetchHandler(db, { onQueued });
    const res = await fetch(
      new Request("http://localhost/argue", {
        method: "POST",
        body: JSON.stringify({
          url: "https://github.com/anthropics/sdk-python/pull/421",
        }),
        headers: { "content-type": "application/json" },
      })
    );

    expect(res.status).toBe(202);
    expect(onQueued).toHaveBeenCalledTimes(1);
  });
});
