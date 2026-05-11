// Adapted from Tenormusica2024/review-fix-pipeline — `/ifr` + `/rfl` fresh-context
// review-fix loop with 5-iter cap and >50% FP early-terminate. Combined with
// Hosico02/agent-self-iteration's verdict gating.
import { describe, expect, it } from "vitest";

import {
  type LoopIteration,
  type ReviewFixLoopConfig,
  type ReviewerVerdict,
  decideNext,
} from "../src/loops/review-fix-loop";

const defaultConfig: ReviewFixLoopConfig = {
  maxIterations: 5,
  falsePositiveTerminationThreshold: 0.5,
};

const passVerdict = (): ReviewerVerdict => ({
  verdict: "pass",
  improvements_exhausted: false,
  issues: [],
  scores: { groundedness: 0.9, specificity: 0.9 },
});

const failVerdict = (): ReviewerVerdict => ({
  verdict: "fail",
  improvements_exhausted: false,
  issues: ["x"],
  scores: { groundedness: 0.5, specificity: 0.5 },
});

// A false-positive iteration: reviewer claimed pass but the gate force-rejected
// it (gate-trust-numbers caught low scores). Tenormusica's pattern treats these
// as a signal that the reviewer is rubber-stamping and the loop should bail.
const fpIteration = (iter: number): LoopIteration => ({
  iter,
  verdict: { ...passVerdict(), scores: { groundedness: 0.4, specificity: 0.4 } },
  gatePassed: false,
});

const honestFailIteration = (iter: number): LoopIteration => ({
  iter,
  verdict: failVerdict(),
  gatePassed: false,
});

const approveIteration = (iter: number): LoopIteration => ({
  iter,
  verdict: passVerdict(),
  gatePassed: true,
});

describe("decideNext — approve on first gate-pass", () => {
  it("returns 'approve' when the latest iteration's gate passed", () => {
    const iterations = [approveIteration(1)];
    expect(decideNext(iterations, defaultConfig).action).toBe("approve");
  });

  it("returns 'approve' even if earlier iterations failed, as long as current passes", () => {
    const iterations = [
      honestFailIteration(1),
      honestFailIteration(2),
      approveIteration(3),
    ];
    expect(decideNext(iterations, defaultConfig).action).toBe("approve");
  });
});

describe("decideNext — max iteration cap", () => {
  it("returns 'max' when iterations.length reaches maxIterations and not approved", () => {
    const iterations = [
      honestFailIteration(1),
      honestFailIteration(2),
      honestFailIteration(3),
      honestFailIteration(4),
      honestFailIteration(5),
    ];
    expect(decideNext(iterations, defaultConfig).action).toBe("max");
  });

  it("returns 'continue' when below the cap and not approved", () => {
    const iterations = [honestFailIteration(1), honestFailIteration(2)];
    expect(decideNext(iterations, defaultConfig).action).toBe("continue");
  });
});

describe("decideNext — false-positive early-terminate (Tenormusica >50%)", () => {
  it("returns 'fp' after 3 iters with 2 false-positives (>50%)", () => {
    const iterations = [fpIteration(1), fpIteration(2), honestFailIteration(3)];
    expect(decideNext(iterations, defaultConfig).action).toBe("fp");
  });

  it("does not fire fp-terminate before iter 3 (need a stable sample)", () => {
    const iterations = [fpIteration(1), fpIteration(2)];
    expect(decideNext(iterations, defaultConfig).action).toBe("continue");
  });

  it("does not fire fp-terminate when FP rate <= 50%", () => {
    const iterations = [
      fpIteration(1),
      honestFailIteration(2),
      honestFailIteration(3),
    ];
    expect(decideNext(iterations, defaultConfig).action).toBe("continue");
  });

  it("returns 'approve' if the latest iter passed even with prior FPs (current wins)", () => {
    const iterations = [
      fpIteration(1),
      fpIteration(2),
      fpIteration(3),
      approveIteration(4),
    ];
    expect(decideNext(iterations, defaultConfig).action).toBe("approve");
  });
});

describe("decideNext — defensive edge cases", () => {
  it("returns 'continue' on empty iterations (the loop has not started yet)", () => {
    expect(decideNext([], defaultConfig).action).toBe("continue");
  });
});
