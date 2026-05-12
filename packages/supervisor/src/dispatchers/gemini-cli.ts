import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import { buildParseFailureVerdict, buildSuccessfulVerdict, buildTransportFailureVerdict, describeProcessFailure } from "./result";
import { withTempWorkspace } from "./temp-workspace";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const GEMINI_BIN = process.env.GEMINI_BIN ?? "/usr/bin/gemini";
const GEMINI_MODEL = process.env.GEMINI_MODEL?.trim() ?? "";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchGeminiCli(
  input: ArgueInput,
  runner: Runner = defaultRunProcess
): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);

  return withTempWorkspace("argued-gemini", async (cwd) => {
    const args = ["-p", prompt, "-o", "json"];
    if (GEMINI_MODEL) {
      args.push("-m", GEMINI_MODEL);
    }

    const result = await runner(GEMINI_BIN, args, {
      cwd,
      env: { GEMINI_CLI_TRUST_WORKSPACE: "true" },
      timeoutMs: 120_000,
    });

    if (result.timedOut || result.exitCode !== 0) {
      return buildTransportFailureVerdict(
        "gemini-cli",
        describeProcessFailure("gemini transport failed", result),
        result.durationMs
      );
    }

    const extracted = extractJsonVerdict(result.stdout);
    if (!extracted.ok) {
      return buildParseFailureVerdict(
        "gemini-cli",
        `gemini parse failed: ${extracted.error}`,
        result.durationMs
      );
    }

    return buildSuccessfulVerdict("gemini-cli", extracted.verdict, result.durationMs);
  });
}
