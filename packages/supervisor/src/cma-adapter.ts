// Adapter: CMA grade ↔ ReviewerVerdict.
//
// The supervisor's whole stack — watchers, votes, gate — speaks
// `ReviewerVerdict` (verdict-gate.ts). The Anthropic outcome-grader
// pattern speaks per-criterion `CmaGradeResult`. This module bridges
// them so any Anthropic-published rubric can be voted across vendors
// without touching the downstream pipeline.
//
// Mapping rules:
//   passed (bool)             → verdict ("pass" | "fail")
//   weighted_average          → scores.groundedness
//   1 - variance(scores)      → scores.specificity (clamped [0,1])
//   criteria with score < t   → issues[] entries with name/score/threshold
//
// Specificity-as-1-minus-variance was chosen because the verdict-gate
// uses specificity as a "did the reviewer commit to concrete numbers"
// signal — high variance across criteria means the model disagrees with
// itself, which is the cross-criterion analogue of vague hedging.

import type {
  CmaGradeResult,
  CmaRubric,
  ReviewerVerdict,
} from "@octogent/core";

const clamp01 = (n: number): number => {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

const variance = (xs: ReadonlyArray<number>): number => {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sq = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / xs.length;
  return sq;
};

export const cmaGradeToReviewerVerdict = (
  grade: CmaGradeResult,
  rubric: CmaRubric,
): ReviewerVerdict => {
  const threshold = rubric.passing_threshold;
  const issues: string[] = [];
  if (!grade.passed) {
    for (const c of rubric.criteria) {
      const score = grade.criterion_scores[c.name];
      // Missing criterion in the scores map counts as below-threshold:
      // the vendor failed to grade it, so it cannot count toward passing.
      if (typeof score !== "number" || !Number.isFinite(score) || score < threshold) {
        const shown = typeof score === "number" ? score.toFixed(2) : "missing";
        issues.push(
          `${c.name}: ${shown} < threshold ${threshold.toFixed(2)}`,
        );
      }
    }
  }

  const scoreValues: number[] = [];
  for (const c of rubric.criteria) {
    const s = grade.criterion_scores[c.name];
    if (typeof s === "number" && Number.isFinite(s)) scoreValues.push(s);
  }
  const v = variance(scoreValues);
  // Variance of values in [0,1] is bounded above by 0.25 (achieved by
  // half-zero / half-one), so 1 - v is naturally in [0.75, 1] for the
  // realistic disagreement range. Clamp anyway to keep the contract
  // explicit if a future caller passes non-unit-interval scores.
  const specificity = clamp01(1 - v);

  return {
    verdict: grade.passed ? "pass" : "fail",
    improvements_exhausted: false,
    issues,
    scores: {
      groundedness: clamp01(grade.weighted_average),
      specificity,
    },
  };
};

// Prompt-injection helper. Returns a system-prefix string that asks the
// LLM to grade against the given rubric and emit a CmaGradeResult JSON
// object at the tail of its response. Tail-JSON contract matches
// parseCmaGradeFromText in @octogent/core.
export const buildCmaPromptInjection = (rubric: CmaRubric): string => {
  const lines: string[] = [];
  lines.push(
    `# CMA Rubric Grading (rubric_id=${rubric.rubric_id}, version=${rubric.rubric_version})`,
  );
  lines.push("");
  lines.push(
    "Grade the produced output against each criterion below. Score every",
  );
  lines.push("criterion as a real number in [0, 1] (higher is better).");
  lines.push("");
  lines.push("Criteria:");
  for (const c of rubric.criteria) {
    lines.push(
      `- ${c.name} (weight=${c.weight.toFixed(2)}): ${c.description}`,
    );
  }
  lines.push("");
  lines.push(
    `Passing threshold (weighted average): ${rubric.passing_threshold.toFixed(2)}`,
  );
  lines.push("");
  lines.push(
    "At the END of your response, emit a single JSON object on its own",
  );
  lines.push("line with this exact shape:");
  lines.push("");
  lines.push("{");
  lines.push('  "criterion_scores": { "<name>": <0..1>, ... },');
  lines.push('  "weighted_average": <0..1>,');
  lines.push('  "passed": <true|false>,');
  lines.push('  "rationale": "<one-paragraph reason>"');
  lines.push("}");
  lines.push("");
  lines.push(
    "Do not wrap the JSON in markdown fences. The final balanced JSON",
  );
  lines.push("object in your response is the grade of record.");
  return lines.join("\n");
};
