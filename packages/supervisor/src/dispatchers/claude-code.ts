import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import { buildParseFailureVerdict, buildSuccessfulVerdict, buildTransportFailureVerdict, describeProcessFailure } from "./result";
import { withTempWorkspace } from "./temp-workspace";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "/root/.local/bin/claude";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchClaudeCode(
  input: ArgueInput,
  runner: Runner = defaultRunProcess
): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);

  return withTempWorkspace("argued-claude", async (cwd) => {
    const result = await runner(CLAUDE_BIN, ["--print", prompt], {
      cwd,
      timeoutMs: 120_000,
    });

    if (result.timedOut || result.exitCode !== 0) {
      return buildTransportFailureVerdict(
        "claude-code",
        describeProcessFailure("claude transport failed", result),
        result.durationMs
      );
    }

    const extracted = extractJsonVerdict(result.stdout);
    if (!extracted.ok) {
      return buildParseFailureVerdict(
        "claude-code",
        `claude parse failed: ${extracted.error}`,
        result.durationMs
      );
    }

    return buildSuccessfulVerdict("claude-code", extracted.verdict, result.durationMs);
  });
}
