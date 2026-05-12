// argue.ts — Supervisor entry point that fans a review request out to 4 CLIs
// in parallel and collects raw verdicts. Each CLI runs independently;
// failures produce a synthetic REJECT so the caller always gets 4 verdicts.

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

export interface RawVerdict {
  cli: CliName;
  decision: "APPROVE" | "REJECT";
  issues: IssueCitation[];
  reasoning: string;
  cost_usd: number;
  duration_ms: number;
}

export interface ArgueOpts {
  dispatch: (cli: CliName, input: ArgueInput) => Promise<RawVerdict>;
}

export async function argue(input: ArgueInput, opts: ArgueOpts) {
  const results = await Promise.allSettled(
    CLIS.map((cli) => opts.dispatch(cli, input))
  );
  const verdicts: RawVerdict[] = [];
  for (let i = 0; i < CLIS.length; i++) {
    const r = results[i]!;
    if (r.status === "fulfilled") {
      verdicts.push(r.value);
    } else {
      verdicts.push({
        cli: CLIS[i],
        decision: "REJECT",
        issues: [{ severity: "error", message: `CLI failed: ${(r.reason as Error).message}` }],
        reasoning: "dispatcher error",
        cost_usd: 0,
        duration_ms: 0,
      });
    }
  }
  return { verdicts };
}

export { CLIS };
