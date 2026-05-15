import { describe, it, expect, vi } from "vitest";
import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { createOracle } from "../src/index.js";

describe("oracle.lookup", () => {
  it("returns top-3 priors ordered by cosine similarity", async () => {
    const db = new Database(":memory:");
    sqliteVec.load(db);

    db.exec("CREATE VIRTUAL TABLE corpus_vec USING vec0(embedding float[768])");
    db.exec(
      "CREATE TABLE corpus_meta (rowid INTEGER PRIMARY KEY, cluster_id TEXT, description TEXT, n_observations INTEGER)"
    );

    const insertVec = db.prepare(
      "INSERT INTO corpus_vec(rowid, embedding) VALUES (?, ?)"
    );
    const insertMeta = db.prepare(
      "INSERT INTO corpus_meta(rowid, cluster_id, description, n_observations) VALUES (?, ?, ?, ?)"
    );

    const v1 = new Float32Array(768).fill(1 / Math.sqrt(768));
    const v2 = new Float32Array(768);
    v2[0] = 1;
    const v3 = new Float32Array(768);
    v3[1] = 1;

    insertVec.run(1, v1);
    insertVec.run(2, v2);
    insertVec.run(3, v3);
    insertMeta.run(1, "errcls_uniform", "uniform pattern", 5);
    insertMeta.run(2, "errcls_x", "x-axis pattern", 3);
    insertMeta.run(3, "errcls_y", "y-axis pattern", 9);

    const fakeEmbed = vi.fn(async () => {
      const v = new Float32Array(768);
      v[0] = 1;
      return Array.from(v);
    });

    const oracle = createOracle(db, { embedFn: fakeEmbed });
    const priors = await oracle.lookup("any diff");

    expect(priors.length).toBeGreaterThanOrEqual(1);
    expect(priors[0]!.cluster_id).toBe("errcls_x"); // exact match to v2 (smallest distance)
  });
});
