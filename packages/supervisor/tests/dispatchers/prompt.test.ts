import { afterEach, describe, expect, it } from "vitest";
import { buildArguePrompt, clearPromptCache } from "../../src/dispatchers/prompt";

afterEach(() => clearPromptCache());

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
      darwin_priors: [
        { cluster_id: "errcls_a", description: "race", n_observations: 7 },
      ],
    });
    expect(p).toContain("errcls_a");
    expect(p).toContain("race");
    expect(p).toContain("seen 7× before");
  });

  it("prepends per-CLI strengths block when cli is provided", () => {
    const input = {
      diff: "x",
      description: "y",
      ciStatus: "none",
      darwin_priors: [],
    };
    const codex = buildArguePrompt(input, "codex");
    const gemini = buildArguePrompt(input, "gemini-cli");
    expect(codex).toContain("Edge case detection");
    expect(codex).toContain("Security analysis");
    expect(gemini).toContain("Large-context cross-reference");
    expect(gemini).toContain("WebDev Arena");
    // both still include the shared base contract
    expect(codex).toMatch(/REQUIRED: every issue MUST include/);
    expect(gemini).toMatch(/REQUIRED: every issue MUST include/);
  });

  it("throws when an unknown cli is supplied (no prompt file on disk)", () => {
    expect(() =>
      buildArguePrompt(
        { diff: "x", description: "y", ciStatus: "none", darwin_priors: [] },
        // @ts-expect-error — intentionally pass an unknown cli
        "not-a-real-cli"
      )
    ).toThrow(/ENOENT|reviewer\.md/);
  });
});
