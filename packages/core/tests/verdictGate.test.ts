// Adapted from Hosico02/agent-self-iteration (reviewer.md JSON contract)
// and Tenormusica2024/review-fix-pipeline (/go-robust rubric thresholds).
// References BriefingDeck's gate-trust-numbers rule from
// /root/briefingdeck/briefingdeck/agents/loop.py (commit e38faa8).
import { describe, expect, it } from "vitest";

import {
  type GateConfig,
  type ReviewerVerdict,
  evaluateVerdict,
  parseAllReviewerVerdicts,
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

// L3 audit r2 (2026-05-12): parseAllReviewerVerdicts is the multi-candidate
// sibling of parseReviewerVerdict. It returns every successfully-narrowed
// verdict in document order so callers that need to act on each verdict in
// the buffer (e.g. the supervisor watcher's multi-verdict-per-chunk path)
// can do so without re-implementing the JSON walker. parseReviewerVerdict
// keeps its "final candidate wins" contract for backwards compat.
describe("parseAllReviewerVerdicts", () => {
  it("returns [] on empty input", () => {
    expect(parseAllReviewerVerdicts("")).toEqual([]);
  });

  it("returns [] on prose with no JSON object", () => {
    expect(parseAllReviewerVerdicts("just notes, no verdict here")).toEqual(
      [],
    );
  });

  it("returns [v] when exactly one verdict is present", () => {
    const raw = JSON.stringify({
      verdict: "pass",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.92, specificity: 0.88 },
    });
    const result = parseAllReviewerVerdicts(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.verdict).toBe("pass");
    expect(result[0]?.scores.groundedness).toBe(0.92);
  });

  it("returns [v1, v2] in document order when two verdicts appear back-to-back", () => {
    const v1 = JSON.stringify({
      verdict: "pass",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.62, specificity: 0.88 },
    });
    const v2 = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["bug remains"],
      scores: { groundedness: 0.4, specificity: 0.5 },
    });
    const raw = `${v1}\n${v2}`;
    const result = parseAllReviewerVerdicts(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.verdict).toBe("pass");
    expect(result[0]?.scores.groundedness).toBe(0.62);
    expect(result[1]?.verdict).toBe("fail");
    expect(result[1]?.scores.groundedness).toBe(0.4);
  });

  it("returns three verdicts in document order when spread across prose preamble", () => {
    const v1 = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["a"],
      scores: { groundedness: 0.3, specificity: 0.3 },
    });
    const v2 = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["b"],
      scores: { groundedness: 0.5, specificity: 0.5 },
    });
    const v3 = JSON.stringify({
      verdict: "pass",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.95, specificity: 0.95 },
    });
    const raw = [
      "First pass review:",
      v1,
      "After iteration 1 the agent re-emitted:",
      v2,
      "Finally:",
      v3,
    ].join("\n");
    const result = parseAllReviewerVerdicts(raw);
    expect(result).toHaveLength(3);
    expect(result[0]?.issues).toEqual(["a"]);
    expect(result[1]?.issues).toEqual(["b"]);
    expect(result[2]?.verdict).toBe("pass");
  });

  it("returns only the successfully-narrowed verdicts when mixed valid + malformed JSON appear", () => {
    // First object is a CoT scratch JSON (missing required fields).
    const scratch = JSON.stringify({ thinking: "scratch", verdict: "pass" });
    // Second is a malformed verdict (verdict: "maybe" — invalid literal).
    const malformed = JSON.stringify({
      verdict: "maybe",
      improvements_exhausted: false,
      issues: [],
      scores: { groundedness: 0.9, specificity: 0.9 },
    });
    // Third is valid.
    const valid = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["real issue"],
      scores: { groundedness: 0.4, specificity: 0.4 },
    });
    const raw = `${scratch}\n${malformed}\n${valid}`;
    const result = parseAllReviewerVerdicts(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.verdict).toBe("fail");
    expect(result[0]?.issues).toEqual(["real issue"]);
  });

  it("returns the same verdict twice when an identical shape is emitted in a row (caller decides dedup)", () => {
    // parseAllReviewerVerdicts MUST NOT dedup — that's a caller concern.
    // The supervisor watcher dedups via seenVerdictKeys; other callers
    // may want every emission.
    const v = JSON.stringify({
      verdict: "fail",
      improvements_exhausted: false,
      issues: ["x"],
      scores: { groundedness: 0.4, specificity: 0.4 },
    });
    const raw = `${v}\n${v}`;
    const result = parseAllReviewerVerdicts(raw);
    expect(result).toHaveLength(2);
    expect(result[0]?.verdict).toBe("fail");
    expect(result[1]?.verdict).toBe("fail");
  });
});
