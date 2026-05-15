import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { createOracle } from "../src/index";

const DB_PATH = process.env.ARGUED_DB_PATH ?? process.env.ORACLE_DB_PATH;

describe.skipIf(!DB_PATH || !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY)("oracle p95 benchmark", () => {
  it("returns top-3 in under 500 ms p95 over 10 sample queries", async () => {
    const db = new Database(DB_PATH!);
    sqliteVec.load(db);
    const oracle = createOracle(db);
    const samples = [
      "fix race condition in async retry handler",
      "add null check to email validation",
      "refactor parser to async",
      "401 unauthorized api key error",
      "double-free in alloc",
      "missing await on promise",
      "off-by-one in pagination",
      "wrong content-type header",
      "deadlock in mutex",
      "stale cache invalidation",
    ];
    const ts: number[] = [];
    for (const s of samples) {
      const t0 = performance.now();
      await oracle.lookup(s);
      ts.push(performance.now() - t0);
    }
    ts.sort((a, b) => a - b);
    const p95 = ts[Math.floor(ts.length * 0.95)];
    console.log(`p95 = ${p95.toFixed(1)} ms over ${ts.length} samples`);
    expect(p95).toBeLessThan(500);
  }, 60_000);
});
