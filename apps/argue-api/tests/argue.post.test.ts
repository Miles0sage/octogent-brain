import { describe, it, expect, beforeEach } from "vitest";
import { handleArguePost } from "../src/routes/argue.post";
import { openDb, migrate, type Db } from "../src/db";

describe("POST /argue", () => {
  let db: Db;
  beforeEach(async () => {
    process.env.ARGUED_DB_PATH = ":memory:";
    db = openDb();
    await migrate(db);
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
    const result = await db.execute({ sql: "SELECT * FROM arguments WHERE id = ?", args: [body.id] });
    expect(result.rows.length).toBe(1);
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
});
