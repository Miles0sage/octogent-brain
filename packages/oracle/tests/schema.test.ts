import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { ensureOracleSchema } from "../src/index.js";

describe("ensureOracleSchema", () => {
  it("creates the vec table and metadata table", () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);

    ensureOracleSchema(db);

    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type IN ('table','virtual table') ORDER BY name")
      .all() as Array<{ name: string }>;

    expect(tables.map((table) => table.name)).toContain("corpus_meta");
    expect(tables.map((table) => table.name)).toContain("corpus_vec");
  });
});
