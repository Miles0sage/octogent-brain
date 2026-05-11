// Adapted from Tenormusica2024/review-fix-pipeline — `/ifr` intent-first review
// + `/rfl` re-review in fresh subagent contexts. The loop caps at maxIterations
// and early-terminates when the false-positive rate (reviewer says "pass" but
// the gate force-rejects it) exceeds the configured threshold. Treats the
// reviewer-claim-vs-gate-decision delta as the FP signal.

import type { ReviewerVerdict } from "../orchestrator/verdict-gate";

export type { ReviewerVerdict } from "../orchestrator/verdict-gate";

export type ReviewFixLoopConfig = {
  maxIterations: number;
  falsePositiveTerminationThreshold: number;
};

export type LoopIteration = {
  iter: number;
  verdict: ReviewerVerdict;
  gatePassed: boolean;
};

export type LoopOutcome = {
  status: "approved" | "max_iterations" | "fp_terminated";
  iterations: LoopIteration[];
  final_verdict: ReviewerVerdict;
};

export type LoopDecision = {
  action: "continue" | "approve" | "max" | "fp";
};

// Frozen — same rationale as DEFAULT_GATE_CONFIG.
export const DEFAULT_REVIEW_FIX_LOOP_CONFIG: Readonly<ReviewFixLoopConfig> = Object.freeze({
  maxIterations: 5,
  falsePositiveTerminationThreshold: 0.5,
});

// A false-positive is any iteration where the reviewer textually said "pass"
// but the verdict gate rejected it. That's the rubber-stamp signal — the
// reviewer is being optimistic in prose but its own numbers don't back it up.
const isFalsePositive = (it: LoopIteration): boolean =>
  it.verdict.verdict === "pass" && !it.gatePassed;

// We require a minimum sample before letting FP rate trigger termination,
// otherwise a single optimistic first iteration would short-circuit the loop
// before the builder has had a chance to react to feedback.
const FP_TERMINATION_MIN_SAMPLE = 3;

export const decideNext = (
  iterations: LoopIteration[],
  config: ReviewFixLoopConfig,
): LoopDecision => {
  if (iterations.length === 0) {
    return { action: "continue" };
  }
  const latest = iterations[iterations.length - 1]!;
  if (latest.gatePassed) {
    return { action: "approve" };
  }
  if (iterations.length >= config.maxIterations) {
    return { action: "max" };
  }
  if (iterations.length >= FP_TERMINATION_MIN_SAMPLE) {
    const fpCount = iterations.filter(isFalsePositive).length;
    const fpRate = fpCount / iterations.length;
    if (fpRate > config.falsePositiveTerminationThreshold) {
      return { action: "fp" };
    }
  }
  return { action: "continue" };
};
