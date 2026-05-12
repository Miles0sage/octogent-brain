import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import { buildParseFailureVerdict, buildSuccessfulVerdict, buildTransportFailureVerdict, describeProcessFailure } from "./result";
import { withTempWorkspace } from "./temp-workspace";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const AIDER_BIN = process.env.AIDER_BIN ?? "/root/.local/bin/aider";
const AIDER_MODEL = process.env.AIDER_MODEL ?? "gemini/gemini-2.5-flash-lite";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchAider(
  input: ArgueInput,
  runner: Runner = defaultRunProcess
): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input, "aider");

  return withTempWorkspace("argued-aider", async (cwd) => {
    const result = await runner(
      AIDER_BIN,
      [
        "--message",
        prompt,
        "--no-stream",
        "--yes-always",
        "--no-pretty",
        "--no-git",
        "--map-tokens",
        "0",
        "--model",
        AIDER_MODEL,
      ],
      { cwd, timeoutMs: 120_000 }
    );

    if (result.timedOut || result.exitCode !== 0) {
      return buildTransportFailureVerdict(
        "aider",
        describeProcessFailure("aider transport failed", result),
        result.durationMs
      );
    }

    const extracted = extractJsonVerdict(result.stdout);
    if (!extracted.ok) {
      return buildParseFailureVerdict(
        "aider",
        `aider parse failed: ${extracted.error}`,
        result.durationMs
      );
    }

    return buildSuccessfulVerdict("aider", extracted.verdict, result.durationMs);
  });
}
