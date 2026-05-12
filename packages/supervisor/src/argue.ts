// argue.ts — Supervisor entry point that fans a review request out to 4 CLIs
// in parallel and collects raw verdicts. Each CLI runs independently;
// transport and parse failures are preserved so callers can separate
// reviewer disagreement from broken infrastructure.

import { buildTransportFailureVerdict } from "./dispatchers/result";

const CLIS = ["aider", "claude-code", "codex", "gemini-cli"] as const;
export type CliName = (typeof CLIS)[number];

export interface Prior {
  cluster_id: string;
  description: string;
  n_observations: number;
  distance?: number;
}

export interface ArgueInput {
  diff: string;
  description: string;
  ciStatus: string;
  darwin_priors: Prior[];
}

export interface IssueCitation {
  severity: string;
  message: string;
  diff_lines?: [number, number];
  darwin_pattern_id?: string;
}

export type VerdictDecision = "APPROVE" | "REJECT";
export type RawVerdictState = "ok" | "parse_failed" | "transport_failed";

export interface RawVerdict {
  cli: CliName;
  decision: VerdictDecision | null;
  issues: IssueCitation[];
  reasoning: string;
  cost_usd: number;
  duration_ms: number;
  state: RawVerdictState;
}

export interface ArgueOpts {
  dispatch: (cli: CliName, input: ArgueInput) => Promise<RawVerdict>;
  onVerdict?: (verdict: RawVerdict) => Promise<void> | void;
}

export async function argue(input: ArgueInput, opts: ArgueOpts) {
  const verdicts = await Promise.all(
    CLIS.map(async (cli) => {
      let verdict: RawVerdict;
      try {
        verdict = await opts.dispatch(cli, input);
      } catch (error) {
        verdict = buildTransportFailureVerdict(
          cli,
          `CLI failed: ${error instanceof Error ? error.message : String(error)}`,
          0
        );
      }
      await opts.onVerdict?.(verdict);
      return verdict;
    })
  );

  return { verdicts };
}

export { CLIS };
