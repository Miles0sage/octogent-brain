import { describe, it, expect } from "vitest";
import { buildArguePrompt } from "../../src/dispatchers/prompt";

describe("buildArguePrompt", () => {
  it("includes diff, ci status, and (no priors) text when priors empty", () => {
    const p = buildArguePrompt({
      diff: "diff --git a/x b/x\n+x",
      description: "fixes a thing",
      ciStatus: "failure",
      darwin_priors: [],
    });
    expect(p).toContain("CI status: failure");
    expect(p).toContain("(no similar past failures");
    expect(p).toContain("diff --git a/x");
    expect(p).toMatch(/REQUIRED: every issue MUST include/);
  });
  it("lists priors when present", () => {
    const p = buildArguePrompt({
      diff: "x",
      description: "y",
      ciStatus: "none",
      darwin_priors: [{ cluster_id: "errcls_a", description: "race", n_observations: 7 }],
    });
    expect(p).toContain("errcls_a");
    expect(p).toContain("race");
    expect(p).toContain("seen 7× before");
  });
});
