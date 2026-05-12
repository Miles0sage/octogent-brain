import { runProcess as defaultRunProcess } from "./spawn-helper";
import { buildArguePrompt } from "./prompt";
import { extractJsonVerdict } from "./extract";
import type { ArgueInput, RawVerdict } from "../argue";
import type { SpawnResult, SpawnOpts } from "./spawn-helper";

const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "/root/.local/bin/claude";

type Runner = (cmd: string, args: string[], opts?: SpawnOpts) => Promise<SpawnResult>;

export async function dispatchClaudeCode(input: ArgueInput, runner: Runner = defaultRunProcess): Promise<RawVerdict> {
  const prompt = buildArguePrompt(input);
  const r = await runner(CLAUDE_BIN, ["--print", prompt], { timeoutMs: 120_000 });
  const ex = extractJsonVerdict(r.stdout);
  if (!ex.ok) {
    return {
      cli: "claude-code",
      decision: "REJECT",
      issues: [{ severity: "error", message: `claude parse failed: ${ex.error}` }],
      reasoning: "extraction error",
      cost_usd: 0,
      duration_ms: r.durationMs,
    };
  }
  return { cli: "claude-code", ...ex.verdict, cost_usd: 0, duration_ms: r.durationMs };
}
