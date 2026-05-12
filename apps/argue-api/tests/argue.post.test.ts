import { describe, it, expect, beforeEach } from "vitest";
import { handleArguePost } from "../src/routes/argue.post";
import { openDb, migrate, type Db } from "../src/db";

describe("POST /argue", () => {
  let db: Db;
  beforeEach(() => {
    process.env.ARGUED_DB_PATH = ":memory:";
    db = openDb();
    migrate(db);
  });

  it("rejects non-github URLs with 400", async () => {
    const req = new Request("http://localhost/argue", {
      method: "POST",
      body: JSON.stringify({ url: "https://gitlab.com/x/y/-/mr/1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleArguePost(req, db);
    expect(res.status).toBe(400);
  });

  it("creates queued argument row for valid PR URL with skipFetch=true", async () => {
    const req = new Request("http://localhost/argue", {
      method: "POST",
      body: JSON.stringify({ url: "https://github.com/anthropics/sdk-python/pull/1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleArguePost(req, db, { skipFetch: true });
    expect(res.status).toBe(202);
    const body = await res.json() as { id: string; status: string };
    expect(body.id).toMatch(/^[a-z0-9]{12}$/);
    expect(body.status).toBe("queued");
    const row = db.query("SELECT * FROM arguments WHERE id = ?").get(body.id) as { pr_sha: string; diff_truncated: string };
    expect(row).toBeTruthy();
    expect(row.pr_sha).toBe("");
    expect(row.diff_truncated).toBe("");
  });

  it("rejects non-PR github URL with 400", async () => {
    const req = new Request("http://localhost/argue", {
      method: "POST",
      body: JSON.stringify({ url: "https://github.com/x/y/issues/1" }),
      headers: { "content-type": "application/json" },
    });
    const res = await handleArguePost(req, db, { skipFetch: true });
    expect(res.status).toBe(400);
  });

  it("reuses an active queued row for the same PR URL", async () => {
    const url = "https://github.com/anthropics/sdk-python/pull/1";
    const first = new Request("http://localhost/argue", {
      method: "POST",
      body: JSON.stringify({ url }),
      headers: { "content-type": "application/json" },
    });
    const second = new Request("http://localhost/argue", {
      method: "POST",
      body: JSON.stringify({ url }),
      headers: { "content-type": "application/json" },
    });

    const firstRes = await handleArguePost(first, db);
    const firstBody = await firstRes.json() as { id: string };
    const secondRes = await handleArguePost(second, db);
    const secondBody = await secondRes.json() as { id: string; deduped?: boolean };

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondBody.deduped).toBe(true);
  });
});
