// Adapted from Hosico02/agent-self-iteration (reviewer.md JSON contract)
// and Tenormusica2024/review-fix-pipeline (/go-robust rubric thresholds).
// References BriefingDeck's gate-trust-numbers rule from
// /root/briefingdeck/briefingdeck/agents/loop.py (commit e38faa8).
import { describe, expect, it } from "vitest";

import {
  type GateConfig,
  type ReviewerVerdict,
  evaluateVerdict,
  parseReviewerVerdict,
} from "../src/orchestrator/verdict-gate";

const defaultConfig: GateConfig = {
  groundednessThreshold: 0.85,
  specificityThreshold: 0.85,
};

const passingVerdict = (
  overrides: Partial<ReviewerVerdict> = {},
): ReviewerVerdict => ({
  verdict: "pass",
  improvements_exhausted: false,
  issues: [],
  scores: { groundedness: 0.9, specificity: 0.9 },
  ...overrides,
});

describe("parseReviewerVerdict — clean JSON", () => {
  it("parses a bare JSON object emitted as the only output", () => {
    const raw = JSON.stringify({
      verdict: "pass",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.92, specificity: 0.88 },
    });
    const result = parseReviewerVerdict(raw);
    expect(result).not.toBeNull();
    expect(result?.verdict).toBe("pass");
    expect(result?.scores.groundedness).toBe(0.92);
  });

  it("parses a fail verdict with issues list", () => {
    const raw = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["unverified-claim:line-42", "missing-citation:line-7"],
      scores: { groundedness: 0.4, specificity: 0.55 },
    });
    const result = parseReviewerVerdict(raw);
    expect(result?.verdict).toBe("fail");
    expect(result?.issues).toHaveLength(2);
  });
});

describe("parseReviewerVerdict — prose wrapper", () => {
  it("extracts the trailing JSON object from a prose-wrapped output", () => {
    const raw = [
      "I reviewed the changes against the rubric.",
      "Two issues stood out around groundedness.",
      "",
      JSON.stringify({
        verdict: "fail",
        improvements_exhausted: false,
        issues: ["unsupported-claim"],
        scores: { groundedness: 0.7, specificity: 0.8 },
      }),
    ].join("\n");
    const result = parseReviewerVerdict(raw);
    expect(result?.verdict).toBe("fail");
    expect(result?.scores.specificity).toBe(0.8);
  });

  it("prefers the LAST JSON object when multiple appear (older Claude versions leaked CoT)", () => {
    const earlier = JSON.stringify({ thinking: "scratch", verdict: "pass" });
    const later = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["regression"],
      scores: { groundedness: 0.5, specificity: 0.5 },
    });
    const raw = `${earlier}\nsome prose between\n${later}`;
    const result = parseReviewerVerdict(raw);
    expect(result?.verdict).toBe("fail");
  });

  it("extracts JSON wrapped in a fenced code block", () => {
    const raw = [
      "Here is my verdict:",
      "```json",
      JSON.stringify({
        verdict: "pass",
        improvements_exhausted: true,
        issues: [],
        scores: { groundedness: 0.95, specificity: 0.91 },
      }),
      "```",
    ].join("\n");
    const result = parseReviewerVerdict(raw);
    expect(result?.verdict).toBe("pass");
    expect(result?.improvements_exhausted).toBe(true);
  });
});

describe("parseReviewerVerdict — malformed input", () => {
  it("returns null on empty input", () => {
    expect(parseReviewerVerdict("")).toBeNull();
  });

  it("returns null on prose with no JSON object", () => {
    expect(parseReviewerVerdict("just some review notes, no json here")).toBeNull();
  });

  it("returns null when JSON is missing required fields", () => {
    const raw = JSON.stringify({ verdict: "pass" });
    expect(parseReviewerVerdict(raw)).toBeNull();
  });

  it("returns null when verdict is not 'pass' or 'fail'", () => {
    const raw = JSON.stringify({
      verdict: "maybe",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.9, specificity: 0.9 },
    });
    expect(parseReviewerVerdict(raw)).toBeNull();
  });

  it("returns null when scores are out of [0,1] range", () => {
    const raw = JSON.stringify({
      verdict: "pass",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 1.4, specificity: 0.5 },
    });
    expect(parseReviewerVerdict(raw)).toBeNull();
  });

  it("returns null when issues is not a string array", () => {
    const raw = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: [1, 2, 3],
      scores: { groundedness: 0.4, specificity: 0.4 },
    });
    expect(parseReviewerVerdict(raw)).toBeNull();
  });
});

describe("evaluateVerdict — gate-trust-numbers", () => {
  it("approves when verdict=pass and both scores meet threshold", () => {
    const result = evaluateVerdict(passingVerdict(), defaultConfig);
    expect(result.passes).toBe(true);
  });

  it("rejects when verdict=pass but groundedness < threshold (mirrors BriefingDeck loop.py)", () => {
    const verdict = passingVerdict({
      scores: { groundedness: 0.6, specificity: 0.9 },
    });
    const result = evaluateVerdict(verdict, defaultConfig);
    expect(result.passes).toBe(false);
    expect(result.reason).toMatch(/groundedness/);
  });

  it("rejects when verdict=pass but specificity < threshold", () => {
    const verdict = passingVerdict({
      scores: { groundedness: 0.95, specificity: 0.5 },
    });
    const result = evaluateVerdict(verdict, defaultConfig);
    expect(result.passes).toBe(false);
    expect(result.reason).toMatch(/specificity/);
  });

  it("rejects when verdict=fail regardless of scores", () => {
    const verdict: ReviewerVerdict = {
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["something"],
      scores: { groundedness: 0.99, specificity: 0.99 },
    };
    const result = evaluateVerdict(verdict, defaultConfig);
    expect(result.passes).toBe(false);
    expect(result.reason).toMatch(/fail/i);
  });

  it("approves at exact threshold (>= boundary)", () => {
    const verdict = passingVerdict({
      scores: { groundedness: 0.85, specificity: 0.85 },
    });
    const result = evaluateVerdict(verdict, defaultConfig);
    expect(result.passes).toBe(true);
  });
});
