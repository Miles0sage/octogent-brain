import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const CODEX_BIN = process.env.CODEX_BIN ?? "/usr/bin/codex";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchCodex(input: ArgueInput, runner: Runner = defaultRunProcess): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);
  const r = await runner(CODEX_BIN, ["exec", prompt], { timeoutMs: 120_000 });
  const ex = extractJsonVerdict(r.stdout);
  if (!ex.ok) {
    return {
      cli: "codex",
      decision: "REJECT",
      issues: [{ severity: "error", message: `codex parse failed: ${ex.error}` }],
      reasoning: "extraction error",
      cost_usd: 0,
      duration_ms: r.durationMs,
    };
  }
  return { cli: "codex", ...ex.verdict, cost_usd: 0, duration_ms: r.durationMs };
}
