import { describe, it, expect, vi } from "vitest";
import { argue } from "../src/argue";

describe("supervisor.argue", () => {
  it("fans request to 4 CLIs in parallel and returns 4 verdicts", async () => {
    const dispatch = vi.fn(async (cli: string) => ({
      cli: cli as any,
      decision: "REJECT" as const,
      issues: [{ severity: "high", message: "x", diff_lines: [1, 5] as [number, number] }],
      reasoning: `from ${cli}`,
      cost_usd: 0.01,
      duration_ms: 100,
      state: "ok" as const,
    }));

    const onVerdict = vi.fn();
    const result = await argue(
      { diff: "x", description: "y", ciStatus: "none", darwin_priors: [] },
      { dispatch, onVerdict }
    );

    expect(result.verdicts).toHaveLength(4);
    expect(result.verdicts.map((v) => v.cli).sort()).toEqual(
      ["aider", "claude-code", "codex", "gemini-cli"]
    );
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(onVerdict).toHaveBeenCalledTimes(4);
  });

  it("returns transport failure verdict when dispatch rejects", async () => {
    const dispatch = vi.fn(async (cli: string) => {
      if (cli === "aider") throw new Error("aider not installed");
      return {
        cli: cli as any,
        decision: "APPROVE" as const,
        issues: [{ severity: "info", message: "ok", diff_lines: [1, 1] as [number, number] }],
        reasoning: `from ${cli}`,
        cost_usd: 0,
        duration_ms: 50,
        state: "ok" as const,
      };
    });

    const result = await argue(
      { diff: "x", description: "y", ciStatus: "none", darwin_priors: [] },
      { dispatch }
    );

    expect(result.verdicts).toHaveLength(4);
    const aider = result.verdicts.find((v) => v.cli === "aider")!;
    expect(aider.decision).toBeNull();
    expect(aider.state).toBe("transport_failed");
    expect(aider.reasoning).toMatch(/transport failure/i);
  });
});
