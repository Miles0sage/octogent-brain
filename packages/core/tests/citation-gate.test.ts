import { describe, it, expect } from "vitest";
import { validateVerdict } from "../src/verdict-gate";

describe("citation enforcement", () => {
  it("rejects APPROVE with empty issues[]", () => {
    const result = validateVerdict({ decision: "APPROVE", issues: [], reasoning: "looks fine" });
    expect(result.gate_pass).toBe(false);
    expect(result.reason).toMatch(/rubber-stamp/i);
  });
  it("rejects REJECT without diff_lines or darwin_pattern_id", () => {
    const result = validateVerdict({
      decision: "REJECT",
      issues: [{ severity: "high", message: "looks bad" }],
      reasoning: "vibes",
    });
    expect(result.gate_pass).toBe(false);
  });
  it("accepts APPROVE with darwin_pattern_id citation", () => {
    const result = validateVerdict({
      decision: "APPROVE",
      issues: [{ severity: "info", message: "checked", darwin_pattern_id: "errcls_3f9f64bf" }],
      reasoning: "verified against prior",
    });
    expect(result.gate_pass).toBe(true);
  });
  it("accepts REJECT with diff_lines citation", () => {
    const result = validateVerdict({
      decision: "REJECT",
      issues: [{ severity: "high", message: "race here", diff_lines: [42, 47] }],
      reasoning: "see line 42-47",
    });
    expect(result.gate_pass).toBe(true);
  });
});
