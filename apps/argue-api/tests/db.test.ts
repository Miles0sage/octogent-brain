import { describe, it, expect, beforeEach } from "vitest";
import { openDb, migrate } from "../src/db";

describe("db", () => {
  beforeEach(() => {
    process.env.ARGUED_DB_PATH = ":memory:";
  });
  it("opens an in-memory db and applies migrations", () => {
    const db = openDb();
    migrate(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain("arguments");
    expect(names).toContain("verdicts");
    expect(names).toContain("votes");
  });
});
