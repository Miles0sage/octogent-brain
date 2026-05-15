// verdict-gate.ts — Citation-enforcing gate for APPROVE/REJECT verdicts.
//
// Any APPROVE or REJECT must include at least one issues[] entry with either:
//   - diff_lines: [start, end]  (number tuple, length 2)
//   - darwin_pattern_id: string
// Otherwise the verdict is treated as a rubber-stamp and gate_pass=false.

export interface IssueCitationInput {
  severity?: string;
  message?: string;
  diff_lines?: unknown;
  darwin_pattern_id?: unknown;
  [key: string]: unknown;
}

export interface VerdictInput {
  decision: "APPROVE" | "REJECT";
  issues: IssueCitationInput[];
  reasoning?: string;
}

export interface VerdictGateResult {
  gate_pass: boolean;
  reason: string;
}

const hasCitation = (issue: IssueCitationInput): boolean => {
  const dl = issue.diff_lines;
  if (
    Array.isArray(dl) &&
    dl.length === 2 &&
    typeof dl[0] === "number" &&
    typeof dl[1] === "number"
  ) {
    return true;
  }
  if (typeof issue.darwin_pattern_id === "string") {
    return true;
  }
  return false;
};

export const validateVerdict = (input: VerdictInput): VerdictGateResult => {
  const issues = input.issues ?? [];

  if (issues.length === 0) {
    return {
      gate_pass: false,
      reason: "rubber-stamp: no diff_lines or darwin_pattern_id citation",
    };
  }

  const cited = issues.some(hasCitation);
  if (!cited) {
    return {
      gate_pass: false,
      reason: "rubber-stamp: no diff_lines or darwin_pattern_id citation",
    };
  }

  return { gate_pass: true, reason: "citation present" };
};
