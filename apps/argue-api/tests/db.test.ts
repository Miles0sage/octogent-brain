import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../src/db";

describe("db", () => {
  beforeEach(() => {
    process.env.ARGUED_DB_PATH = ":memory:";
  });

  it("opens an in-memory db and applies migrations", () => {
    const db = openDb();
    migrate(db);
    const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
    const names = rows.map((r) => r.name);
    expect(names).toContain("arguments");
    expect(names).toContain("oracle_cache");
    expect(names).toContain("verdicts");
    expect(names).toContain("votes");
  });

  it("accepts parse and transport verdict states after migration", () => {
    const db = openDb();
    migrate(db);

    db.query(
      `INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
       VALUES ('abc123def456', 'https://github.com/acme/repo/pull/1', '', '', null, '', 'none', 'queued', unixepoch())`
    ).run();

    expect(() =>
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
      ).run("abc123def456", "codex", "PARSE_FAILED", "[]", "parse failure", 0, 1, 0)
    ).not.toThrow();

    expect(() =>
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
      ).run("abc123def456", "gemini-cli", "TRANSPORT_FAILED", "[]", "transport failure", 0, 1, 0)
    ).not.toThrow();
  });
});
