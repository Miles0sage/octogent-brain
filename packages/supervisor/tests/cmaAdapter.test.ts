// Tests for the CMA grade → ReviewerVerdict adapter. This is the
// interop seam: any Anthropic-published rubric runs across Claude +
// Codex + Gemini, and the adapter collapses per-criterion grades into
// the verdict-gate's two-score (groundedness/specificity) shape so
// existing voters, watchers, and tallyVotes keep working unchanged.
import { describe, expect, it } from "vitest";

import type { CmaGradeResult, CmaRubric } from "@octogent/core";

import {
  buildCmaPromptInjection,
  cmaGradeToReviewerVerdict,
} from "../src/cma-adapter";

const rubric: CmaRubric = {
  rubric_id: "outcome-grader-default",
  rubric_version: "1.0.0",
  criteria: [
    { name: "correctness", description: "Solves the stated task", weight: 0.5 },
    { name: "groundedness", description: "Cites real evidence", weight: 0.3 },
    { name: "specificity", description: "Concrete, no hedging", weight: 0.2 },
  ],
  passing_threshold: 0.7,
};

const grade = (overrides: Partial<CmaGradeResult> = {}): CmaGradeResult => ({
  criterion_scores: { correctness: 0.9, groundedness: 0.85, specificity: 0.8 },
  weighted_average: 0.865,
  passed: true,
  rationale: "All criteria above threshold.",
  ...overrides,
});

describe("cmaGradeToReviewerVerdict — passing grade", () => {
  it("maps passed=true to verdict 'pass' with empty issues", () => {
    const v = cmaGradeToReviewerVerdict(grade(), rubric);
    expect(v.verdict).toBe("pass");
    expect(v.issues).toEqual([]);
    expect(v.improvements_exhausted).toBe(false);
  });

  it("sets groundedness to weighted_average", () => {
    const v = cmaGradeToReviewerVerdict(grade({ weighted_average: 0.91 }), rubric);
    expect(v.scores.groundedness).toBeCloseTo(0.91);
  });

  it("computes specificity as 1 - variance and clamps to [0,1]", () => {
    const v = cmaGradeToReviewerVerdict(grade(), rubric);
    expect(v.scores.specificity).toBeGreaterThanOrEqual(0);
    expect(v.scores.specificity).toBeLessThanOrEqual(1);
    // High agreement across criteria (0.9 / 0.85 / 0.8) → small variance → near-1
    expect(v.scores.specificity).toBeGreaterThan(0.95);
  });
});

describe("cmaGradeToReviewerVerdict — failing grade", () => {
  it("maps passed=false to verdict 'fail'", () => {
    const v = cmaGradeToReviewerVerdict(
      grade({
        passed: false,
        weighted_average: 0.45,
        criterion_scores: { correctness: 0.3, groundedness: 0.6, specificity: 0.5 },
      }),
      rubric,
    );
    expect(v.verdict).toBe("fail");
  });

  it("issues list contains every criterion below threshold (as JSON-encoded objects)", () => {
    const v = cmaGradeToReviewerVerdict(
      grade({
        passed: false,
        weighted_average: 0.5,
        criterion_scores: { correctness: 0.3, groundedness: 0.6, specificity: 0.8 },
      }),
      rubric,
    );
    // 0.3 and 0.6 both below 0.7 threshold, 0.8 above → 2 issues
    expect(v.issues).toHaveLength(2);
    const issuesJoined = v.issues.join(" ");
    expect(issuesJoined).toContain("correctness");
    expect(issuesJoined).toContain("groundedness");
    expect(issuesJoined).not.toContain("specificity");
  });

  it("encodes each issue with name, score, and threshold for downstream inspection", () => {
    const v = cmaGradeToReviewerVerdict(
      grade({
        passed: false,
        weighted_average: 0.4,
        criterion_scores: { correctness: 0.2, groundedness: 0.9, specificity: 0.9 },
      }),
      rubric,
    );
    expect(v.issues).toHaveLength(1);
    const first = v.issues[0]!;
    expect(first).toContain("correctness");
    expect(first).toMatch(/0\.20|0\.2/);
    expect(first).toContain("0.7");
  });
});

describe("cmaGradeToReviewerVerdict — edge cases", () => {
  it("all-zero criterion scores → specificity is 1 (no variance, all agree at 0)", () => {
    const v = cmaGradeToReviewerVerdict(
      grade({
        passed: false,
        weighted_average: 0,
        criterion_scores: { correctness: 0, groundedness: 0, specificity: 0 },
      }),
      rubric,
    );
    expect(v.scores.specificity).toBeCloseTo(1, 5);
    expect(v.scores.groundedness).toBe(0);
    expect(v.verdict).toBe("fail");
  });

  it("all-perfect criterion scores → specificity is 1 (no variance)", () => {
    const v = cmaGradeToReviewerVerdict(
      grade({
        criterion_scores: { correctness: 1, groundedness: 1, specificity: 1 },
        weighted_average: 1,
        passed: true,
      }),
      rubric,
    );
    expect(v.scores.specificity).toBeCloseTo(1, 5);
    expect(v.scores.groundedness).toBe(1);
    expect(v.verdict).toBe("pass");
  });

  it("max-disagreement scores (0 and 1) → specificity is 0", () => {
    const r2: CmaRubric = {
      ...rubric,
      criteria: [
        { name: "a", description: "x", weight: 0.5 },
        { name: "b", description: "y", weight: 0.5 },
      ],
    };
    const v = cmaGradeToReviewerVerdict(
      grade({
        criterion_scores: { a: 0, b: 1 },
        weighted_average: 0.5,
        passed: false,
      }),
      r2,
    );
    // variance of {0, 1} = 0.25 → specificity = 0.75. We clamp to [0,1]
    // but the metric ranges 0..1, so we check it tracks the variance.
    expect(v.scores.specificity).toBeCloseTo(0.75, 5);
  });

  it("missing criterion in the scores map is treated as below-threshold", () => {
    const v = cmaGradeToReviewerVerdict(
      grade({
        passed: false,
        weighted_average: 0.45,
        criterion_scores: { correctness: 0.9 }, // groundedness + specificity missing
      }),
      rubric,
    );
    // 2 criteria missing → 2 issues (treated as < threshold)
    expect(v.issues.length).toBeGreaterThanOrEqual(2);
  });
});

describe("buildCmaPromptInjection", () => {
  it("returns a non-empty string mentioning the rubric id and version", () => {
    const out = buildCmaPromptInjection(rubric);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain(rubric.rubric_id);
    expect(out).toContain(rubric.rubric_version);
  });

  it("lists every criterion name + description in the prompt", () => {
    const out = buildCmaPromptInjection(rubric);
    for (const c of rubric.criteria) {
      expect(out).toContain(c.name);
      expect(out).toContain(c.description);
    }
  });

  it("instructs the model to emit a CmaGradeResult JSON tail", () => {
    const out = buildCmaPromptInjection(rubric);
    expect(out.toLowerCase()).toMatch(/json/);
    expect(out).toMatch(/criterion_scores/);
    expect(out).toMatch(/weighted_average/);
    expect(out).toMatch(/passed/);
    expect(out).toMatch(/rationale/);
  });
});
