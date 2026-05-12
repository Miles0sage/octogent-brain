import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../src/db";

describe("db", () => {
  beforeEach(() => {
    process.env.ARGUED_DB_PATH = ":memory:";
  });
  it("opens an in-memory db and applies migrations", async () => {
    const db = openDb();
    await migrate(db);
    const result = await db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = result.rows.map((r) => String(r.name));
    expect(names).toContain("arguments");
    expect(names).toContain("verdicts");
    expect(names).toContain("votes");
  });
});
