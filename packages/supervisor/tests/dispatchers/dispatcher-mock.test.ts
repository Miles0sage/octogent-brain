import { describe, it, expect, vi } from "vitest";

import { dispatchAider } from "../../src/dispatchers/aider";
import { dispatchClaudeCode } from "../../src/dispatchers/claude-code";
import { dispatchCodex } from "../../src/dispatchers/codex";
import { dispatchGeminiCli } from "../../src/dispatchers/gemini-cli";
import type { SpawnResult } from "../../src/dispatchers/spawn-helper";

const INPUT = { diff: "x", description: "y", ciStatus: "none", darwin_priors: [] };

const OK_OUT = `{"decision":"REJECT","issues":[{"severity":"high","message":"problem","diff_lines":[1,5]}],"reasoning":"caught"}`;

function makeRunner(stdout: string, durationMs = 50): () => Promise<SpawnResult> {
  return vi.fn().mockResolvedValue({
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs,
  });
}

describe("dispatchers (mocked subprocess)", () => {
  for (const [name, fn, expectedCli] of [
    ["aider", dispatchAider, "aider"],
    ["claude-code", dispatchClaudeCode, "claude-code"],
    ["codex", dispatchCodex, "codex"],
    ["gemini-cli", dispatchGeminiCli, "gemini-cli"],
  ] as const) {
    it(`${name} returns parsed verdict on clean stdout`, async () => {
      const runner = makeRunner(OK_OUT);
      const v = await fn(INPUT, runner);
      expect(v.cli).toBe(expectedCli);
      expect(v.decision).toBe("REJECT");
      expect(v.duration_ms).toBe(50);
      expect(v.state).toBe("ok");
    });

    it(`${name} returns parse failure on malformed stdout`, async () => {
      const runner = makeRunner("no json here");
      const v = await fn(INPUT, runner);
      expect(v.cli).toBe(expectedCli);
      expect(v.decision).toBeNull();
      expect(v.reasoning).toMatch(/parse failure/i);
      expect(v.state).toBe("parse_failed");
    });
  }
});
