import { describe, expect, it } from "vitest";
import {
  evaluateReleaseGate,
  formatGateVerdict,
  type SmokeArtifact,
} from "../src/release-gate";

const baseArtifact = (overrides: Partial<SmokeArtifact["result"]> = {}): SmokeArtifact => ({
  prUrl: "https://github.com/example/repo/pull/1",
  wallMs: 60_000,
  result: {
    id: "abc123",
    status: "done",
    prSha: "deadbeef",
    summary: {
      totalVerdicts: 4,
      consensus: "INCOMPLETE",
      transportFailed: 1,
    },
    verdicts: [
      { cli: "aider", decision: "APPROVE" },
      { cli: "claude-code", decision: "APPROVE" },
      { cli: "codex", decision: "TRANSPORT_FAILED" },
      { cli: "gemini-cli", decision: "REJECT" },
    ],
    ...overrides,
  },
});

describe("evaluateReleaseGate", () => {
  it("passes on 4 verdicts + status=done even with INCOMPLETE consensus", () => {
    const v = evaluateReleaseGate(baseArtifact());
    expect(v.pass).toBe(true);
    expect(v.reasons).toEqual([]);
    expect(v.observed.transportFailed).toBe(1);
  });

  it("passes on a fully clean APPROVE consensus", () => {
    const v = evaluateReleaseGate(
      baseArtifact({
        summary: { totalVerdicts: 4, consensus: "APPROVE", transportFailed: 0 },
        verdicts: [
          { cli: "aider", decision: "APPROVE" },
          { cli: "claude-code", decision: "APPROVE" },
          { cli: "codex", decision: "APPROVE" },
          { cli: "gemini-cli", decision: "APPROVE" },
        ],
      })
    );
    expect(v.pass).toBe(true);
  });

  it("fails when pipeline crashed (status=error)", () => {
    const v = evaluateReleaseGate(
      baseArtifact({ status: "error" })
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toContain('pipeline status is "error"');
  });

  it("fails when verdict count is below the expected CLI count", () => {
    const v = evaluateReleaseGate(
      baseArtifact({
        summary: { totalVerdicts: 3, consensus: "SPLIT", transportFailed: 0 },
        verdicts: [
          { cli: "aider", decision: "APPROVE" },
          { cli: "claude-code", decision: "APPROVE" },
          { cli: "gemini-cli", decision: "REJECT" },
        ],
      })
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toContain("got 3 verdicts");
    expect(v.reasons.join(" ")).toContain("missing verdict rows for: codex");
  });

  it("fails when consensus is null", () => {
    const v = evaluateReleaseGate(
      baseArtifact({
        summary: { totalVerdicts: 4, consensus: null, transportFailed: 0 },
      })
    );
    expect(v.pass).toBe(false);
    expect(v.reasons.join(" ")).toContain("consensus is null");
  });
});

describe("formatGateVerdict", () => {
  it("prints PASS line with observed metrics", () => {
    const text = formatGateVerdict(evaluateReleaseGate(baseArtifact()));
    expect(text).toContain("RELEASE GATE: PASS");
    expect(text).toContain("verdicts=4/4");
    expect(text).toContain("consensus=INCOMPLETE");
    expect(text).toContain("transportFailed=1");
  });

  it("prints FAIL line plus indented reasons", () => {
    const text = formatGateVerdict(
      evaluateReleaseGate(baseArtifact({ status: "error" }))
    );
    expect(text).toContain("RELEASE GATE: FAIL");
    expect(text).toContain("Reasons:");
    expect(text).toContain('  - pipeline status is "error"');
  });
});
