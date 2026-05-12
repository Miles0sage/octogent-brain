import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const GEMINI_BIN = process.env.GEMINI_BIN ?? "/usr/bin/gemini";
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.0-flash-exp";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchGeminiCli(input: ArgueInput, runner: Runner = defaultRunProcess): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);
  const r = await runner(
    GEMINI_BIN,
    ["-p", prompt, "-m", GEMINI_MODEL],
    { timeoutMs: 120_000 }
  );
  const ex = extractJsonVerdict(r.stdout);
  if (!ex.ok) {
    return {
      cli: "gemini-cli",
      decision: "REJECT",
      issues: [{ severity: "error", message: `gemini parse failed: ${ex.error}` }],
      reasoning: "extraction error",
      cost_usd: 0,
      duration_ms: r.durationMs,
    };
  }
  return { cli: "gemini-cli", ...ex.verdict, cost_usd: 0, duration_ms: r.durationMs };
}
