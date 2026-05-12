// Tests for the CmaRubric / CmaGradeResult schema. Mirrors the Anthropic
// `CMA_verify_with_outcome_grader.ipynb` outcome-grader shape (cookbook PR
// #599, 2026-05-06). The contract is "Anthropic publishes a rubric, our
// supervisor grades any vendor against it." Schema is therefore stable —
// the type-guards below are the bouncer.
import { describe, expect, it } from "vitest";

import {
  isCmaGradeResult,
  isCmaRubric,
  parseCmaGradeFromText,
  type CmaGradeResult,
  type CmaRubric,
} from "../src/domain/cma-rubric";

const validRubric = (overrides: Partial<CmaRubric> = {}): CmaRubric => ({
  rubric_id: "outcome-grader-default",
  rubric_version: "1.0.0",
  criteria: [
    { name: "correctness", description: "Solves the stated task", weight: 0.5 },
    { name: "groundedness", description: "Cites real evidence", weight: 0.3 },
    { name: "specificity", description: "Concrete, no hedging", weight: 0.2 },
  ],
  passing_threshold: 0.7,
  ...overrides,
});

const validGrade = (overrides: Partial<CmaGradeResult> = {}): CmaGradeResult => ({
  criterion_scores: { correctness: 0.9, groundedness: 0.8, specificity: 0.85 },
  weighted_average: 0.86,
  passed: true,
  rationale: "All criteria met with concrete evidence.",
  ...overrides,
});

describe("isCmaRubric — accepts valid shapes", () => {
  it("accepts a well-formed rubric", () => {
    expect(isCmaRubric(validRubric())).toBe(true);
  });

  it("accepts a rubric with a single criterion at full weight", () => {
    const r = validRubric({
      criteria: [{ name: "only", description: "sole", weight: 1 }],
    });
    expect(isCmaRubric(r)).toBe(true);
  });

  it("accepts threshold at exact bounds 0 and 1", () => {
    expect(isCmaRubric(validRubric({ passing_threshold: 0 }))).toBe(true);
    expect(isCmaRubric(validRubric({ passing_threshold: 1 }))).toBe(true);
  });
});

describe("isCmaRubric — rejects invalid shapes", () => {
  it("rejects null and non-objects", () => {
    expect(isCmaRubric(null)).toBe(false);
    expect(isCmaRubric(undefined)).toBe(false);
    expect(isCmaRubric("rubric")).toBe(false);
    expect(isCmaRubric(42)).toBe(false);
    expect(isCmaRubric([])).toBe(false);
  });

  it("rejects negative weights", () => {
    const r = validRubric({
      criteria: [
        { name: "a", description: "x", weight: -0.1 },
        { name: "b", description: "y", weight: 1.1 },
      ],
    });
    expect(isCmaRubric(r)).toBe(false);
  });

  it("rejects weights greater than 1", () => {
    const r = validRubric({
      criteria: [{ name: "a", description: "x", weight: 1.5 }],
    });
    expect(isCmaRubric(r)).toBe(false);
  });

  it("rejects empty criteria array", () => {
    expect(isCmaRubric(validRubric({ criteria: [] }))).toBe(false);
  });

  it("rejects threshold outside [0,1]", () => {
    expect(isCmaRubric(validRubric({ passing_threshold: -0.01 }))).toBe(false);
    expect(isCmaRubric(validRubric({ passing_threshold: 1.01 }))).toBe(false);
  });

  it("rejects missing rubric_id / rubric_version", () => {
    const { rubric_id: _id, ...rest } = validRubric();
    expect(isCmaRubric(rest)).toBe(false);
    const { rubric_version: _v, ...rest2 } = validRubric();
    expect(isCmaRubric(rest2)).toBe(false);
  });

  it("rejects criteria with missing fields", () => {
    const r = validRubric({
      criteria: [{ name: "x", weight: 0.5 } as unknown as CmaRubric["criteria"][number]],
    });
    expect(isCmaRubric(r)).toBe(false);
  });
});

describe("isCmaGradeResult — type guard", () => {
  it("accepts a well-formed grade", () => {
    expect(isCmaGradeResult(validGrade())).toBe(true);
  });

  it("rejects non-object input", () => {
    expect(isCmaGradeResult(null)).toBe(false);
    expect(isCmaGradeResult("grade")).toBe(false);
  });

  it("rejects weighted_average outside [0,1]", () => {
    expect(isCmaGradeResult(validGrade({ weighted_average: 1.2 }))).toBe(false);
    expect(isCmaGradeResult(validGrade({ weighted_average: -0.1 }))).toBe(false);
  });

  it("rejects non-numeric criterion_scores", () => {
    const g = validGrade({
      criterion_scores: { correctness: "high" as unknown as number },
    });
    expect(isCmaGradeResult(g)).toBe(false);
  });

  it("rejects criterion_scores outside [0,1]", () => {
    expect(
      isCmaGradeResult(validGrade({ criterion_scores: { correctness: 1.5 } })),
    ).toBe(false);
  });

  it("rejects missing `passed` boolean", () => {
    const { passed: _p, ...rest } = validGrade();
    expect(isCmaGradeResult(rest)).toBe(false);
  });
});

describe("parseCmaGradeFromText — JSON tail extraction", () => {
  it("returns null on empty / non-string input", () => {
    expect(parseCmaGradeFromText("")).toBeNull();
    expect(parseCmaGradeFromText("no json here")).toBeNull();
  });

  it("parses a bare grade JSON", () => {
    const g = validGrade();
    const out = parseCmaGradeFromText(JSON.stringify(g));
    expect(out).not.toBeNull();
    expect(out?.passed).toBe(true);
    expect(out?.weighted_average).toBeCloseTo(0.86);
  });

  it("extracts trailing JSON from a prose-wrapped LLM output", () => {
    const raw = [
      "Here is my grade against the rubric.",
      "I weighted correctness highest as instructed.",
      "",
      JSON.stringify(validGrade({ passed: false, weighted_average: 0.55 })),
    ].join("\n");
    const out = parseCmaGradeFromText(raw);
    expect(out?.passed).toBe(false);
    expect(out?.weighted_average).toBeCloseTo(0.55);
  });

  it("prefers the LAST valid JSON when multiple candidates appear", () => {
    const earlier = JSON.stringify({ thinking: "scratch", weighted_average: 0.99 });
    const later = JSON.stringify(validGrade({ weighted_average: 0.42, passed: false }));
    const raw = `${earlier}\n${later}`;
    const out = parseCmaGradeFromText(raw);
    expect(out?.weighted_average).toBeCloseTo(0.42);
    expect(out?.passed).toBe(false);
  });

  it("returns null when every JSON candidate fails the shape guard", () => {
    const raw = `${JSON.stringify({ not: "a grade" })}\n${JSON.stringify({ also: false })}`;
    expect(parseCmaGradeFromText(raw)).toBeNull();
  });
});
