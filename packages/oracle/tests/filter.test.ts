import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { filterCorpus, type CorpusEntry } from "../src/filter.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("filterCorpus", () => {
  it("drops short descriptions and auth_error class", () => {
    const lines = readFileSync(join(here, "fixtures/corpus-sample.jsonl"), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l) as CorpusEntry);
    const kept = filterCorpus(lines);
    expect(kept.map((e) => e.cluster_id)).toEqual(["errcls_a"]);
  });
});
