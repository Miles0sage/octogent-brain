import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const AIDER_BIN = process.env.AIDER_BIN ?? "/root/.local/bin/aider";
const AIDER_MODEL = process.env.AIDER_MODEL ?? "gemini/gemini-2.0-flash-exp";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchAider(input: ArgueInput, runner: Runner = defaultRunProcess): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);
  const r = await runner(
    AIDER_BIN,
    ["--message", prompt, "--no-stream", "--yes-always", "--no-pretty", "--model", AIDER_MODEL],
    { timeoutMs: 120_000 }
  );
  const ex = extractJsonVerdict(r.stdout);
  if (!ex.ok) {
    return {
      cli: "aider",
      decision: "REJECT",
      issues: [{ severity: "error", message: `aider parse failed: ${ex.error}` }],
      reasoning: "extraction error",
      cost_usd: 0,
      duration_ms: r.durationMs,
    };
  }
  return { cli: "aider", ...ex.verdict, cost_usd: 0, duration_ms: r.durationMs };
}
