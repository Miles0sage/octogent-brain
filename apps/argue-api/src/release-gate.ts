// release-gate.ts — pure evaluator for the seeded-smoke release gate.
// Reads the shape that scripts/smoke-real-pr.ts writes to result.json and
// reports whether the pipeline plumbing held end-to-end. The gate
// deliberately does NOT fail on INCOMPLETE consensus: vendor-degraded
// runs are honest outcomes that the banner already surfaces. The gate
// is for: "did the server crash, did we lose verdicts, did the pipeline
// truncate".

export interface SmokeArtifact {
  prUrl: string;
  wallMs: number;
  result: {
    id: string;
    status: "queued" | "running" | "done" | "error";
    prSha: string;
    summary: {
      totalVerdicts: number;
      consensus: "APPROVE" | "REJECT" | "SPLIT" | "INCOMPLETE" | null;
      transportFailed: number;
    };
    verdicts: Array<{ cli: string; decision: string }>;
  };
}

export interface GateVerdict {
  pass: boolean;
  reasons: string[];
  expectedCliCount: number;
  observed: {
    status: string;
    totalVerdicts: number;
    consensus: string | null;
    transportFailed: number;
  };
}

const REQUIRED_CLIS = ["aider", "claude-code", "codex", "gemini-cli"] as const;

export function evaluateReleaseGate(artifact: SmokeArtifact): GateVerdict {
  const reasons: string[] = [];
  const result = artifact.result;

  if (result.status !== "done") {
    reasons.push(`pipeline status is "${result.status}", expected "done"`);
  }

  if (result.summary.totalVerdicts !== REQUIRED_CLIS.length) {
    reasons.push(
      `got ${result.summary.totalVerdicts} verdicts, expected ${REQUIRED_CLIS.length}`
    );
  }

  const seen = new Set(result.verdicts.map((v) => v.cli));
  const missing = REQUIRED_CLIS.filter((cli) => !seen.has(cli));
  if (missing.length > 0) {
    reasons.push(`missing verdict rows for: ${missing.join(", ")}`);
  }

  if (result.summary.consensus == null) {
    reasons.push("consensus is null — pipeline produced no summary");
  }

  return {
    pass: reasons.length === 0,
    reasons,
    expectedCliCount: REQUIRED_CLIS.length,
    observed: {
      status: result.status,
      totalVerdicts: result.summary.totalVerdicts,
      consensus: result.summary.consensus,
      transportFailed: result.summary.transportFailed,
    },
  };
}

export function formatGateVerdict(verdict: GateVerdict): string {
  const header = verdict.pass ? "RELEASE GATE: PASS" : "RELEASE GATE: FAIL";
  const observed =
    `  status=${verdict.observed.status} ` +
    `verdicts=${verdict.observed.totalVerdicts}/${verdict.expectedCliCount} ` +
    `consensus=${verdict.observed.consensus ?? "null"} ` +
    `transportFailed=${verdict.observed.transportFailed}`;
  if (verdict.pass) return `${header}\n${observed}`;
  const reasons = verdict.reasons.map((r) => `  - ${r}`).join("\n");
  return `${header}\n${observed}\nReasons:\n${reasons}`;
}
