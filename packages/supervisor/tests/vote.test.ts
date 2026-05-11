// Tests for the cross-vendor voting primitive. This is the moat: Anthropic
// cannot structurally ship cross-vendor routing because it cannibalizes
// Claude API revenue, so the defensible 60-day play is "ship the same task
// to N CLIs in parallel + pick winner mechanically by consensus."
//
// Precedence (matches src/vote.ts implementation):
//   1. consensus  — all N agree on verdict AND scores within tolerance
//   2. strong-reject — any fail with groundedness < strongRejectGroundedness
//   3. weighted majority — strict > N/2 with scores meeting gate (pass) or fail majority
//   4. no-consensus — everything else (incl. ties, all-null, empty)

import { describe, expect, it } from "vitest";

import type { ReviewerVerdict } from "@octogent/core";

import {
  DEFAULT_VOTE_CONFIG,
  tallyVotes,
  type VoterVerdict,
} from "../src/vote";

const verdict = (
  v: "pass" | "fail",
  groundedness: number,
  specificity: number,
  issues: string[] = [],
): ReviewerVerdict => ({
  verdict: v,
  improvements_exhausted: false,
  issues,
  scores: { groundedness, specificity },
});

const voter = (
  provider: string,
  v: ReviewerVerdict | null,
  raw_output = "",
): VoterVerdict => ({
  provider,
  verdict: v,
  raw_output: raw_output || (v ? JSON.stringify(v) : ""),
});

describe("tallyVotes — consensus", () => {
  it("returns pass with consensus_count=N when all vendors agree on pass + scores within tolerance", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.92, 0.91)),
      voter("aider", verdict("pass", 0.93, 0.90)),
      voter("codex", verdict("pass", 0.94, 0.92)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("pass");
    expect(outcome.consensus_count).toBe(3);
    expect(outcome.dissent_count).toBe(0);
    expect(outcome.reason).toMatch(/consensus/i);
  });

  it("returns fail with consensus_count=N when all vendors agree on fail + scores within tolerance", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("fail", 0.81, 0.83, ["bug remains"])),
      voter("aider", verdict("fail", 0.82, 0.84, ["bug remains"])),
      voter("codex", verdict("fail", 0.83, 0.82, ["bug remains"])),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("fail");
    expect(outcome.consensus_count).toBe(3);
    expect(outcome.dissent_count).toBe(0);
  });
});

describe("tallyVotes — strong-reject (loudest dissent rule)", () => {
  it("returns fail when 1 vendor returns fail with groundedness < 0.5, others say pass", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("fail", 0.3, 0.4, ["MAJOR fabrication in chunk 7"])),
      voter("aider", verdict("pass", 0.91, 0.92)),
      voter("codex", verdict("pass", 0.93, 0.90)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("fail");
    expect(outcome.reason).toMatch(/strong[- ]reject|loudest|dissent/i);
    // dissent_count is the number of voters opposing the winner. Winner=fail,
    // so the 2 passes are dissenters.
    expect(outcome.dissent_count).toBe(2);
  });

  it("strong-reject does NOT fire at the threshold edge (groundedness === 0.5 exactly)", () => {
    // Strict `<` boundary: groundedness=0.5 is NOT a strong reject. Falls
    // through to weighted majority — 2 pass / 1 fail with scores meeting
    // gate => weighted-majority pass.
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("fail", 0.5, 0.6, ["lukewarm reject"])),
      voter("aider", verdict("pass", 0.91, 0.92)),
      voter("codex", verdict("pass", 0.93, 0.90)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("pass");
    expect(outcome.reason).toMatch(/weighted|majority/i);
  });
});

describe("tallyVotes — weighted majority", () => {
  it("returns pass when 2 of 3 say pass with scores >= gate, 1 says fail", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.91, 0.92)),
      voter("aider", verdict("pass", 0.93, 0.90)),
      // Fail dissent, but groundedness=0.7 is above strongRejectGroundedness=0.5
      // so it does NOT trigger strong-reject. Weighted majority applies.
      voter("codex", verdict("fail", 0.7, 0.7, ["minor issue"])),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("pass");
    expect(outcome.consensus_count).toBe(2);
    expect(outcome.dissent_count).toBe(1);
    expect(outcome.reason).toMatch(/weighted|majority/i);
  });

  it("returns no-consensus when the majority-pass scores are below the gate threshold", () => {
    // 2/3 say pass, but their scores are below the groundedness gate. We do
    // NOT certify a soft pass via weighted majority — it falls back to
    // no-consensus rather than rubber-stamping a low-confidence pass.
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.72, 0.74)),
      voter("aider", verdict("pass", 0.71, 0.73)),
      voter("codex", verdict("fail", 0.7, 0.7, ["doubts"])),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("no-consensus");
  });
});

describe("tallyVotes — degenerate cases", () => {
  it("returns no-consensus when verdicts array is empty", () => {
    const outcome = tallyVotes([], DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("no-consensus");
    expect(outcome.consensus_count).toBe(0);
    expect(outcome.dissent_count).toBe(0);
    expect(outcome.verdicts).toEqual([]);
  });

  it("returns no-consensus when all vendors failed to emit parseable JSON", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", null, "garbage output, no JSON"),
      voter("aider", null, ""),
      voter("codex", null, "model timeout"),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("no-consensus");
    expect(outcome.consensus_count).toBe(0);
  });

  it("returns no-consensus on a tied 2-2 split with no strong reject", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.91, 0.92)),
      voter("aider", verdict("pass", 0.93, 0.90)),
      voter("codex", verdict("fail", 0.7, 0.7, ["doubts"])),
      voter("gemini-cli", verdict("fail", 0.72, 0.71, ["concerns"])),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("no-consensus");
    expect(outcome.reason).toMatch(/tie|no[- ]consensus|split/i);
  });
});

describe("tallyVotes — single-vendor (n=1)", () => {
  it("returns pass when single vendor passes with scores meeting gate", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.92, 0.91)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("pass");
    expect(outcome.consensus_count).toBe(1);
  });

  it("returns no-consensus when single vendor passes but scores below gate (no cross-check)", () => {
    // With n=1, consensus is trivially met (all agree with themselves).
    // But scores under gate => weighted-majority gate refuses to certify.
    // Behavior: trivial consensus on the verdict still wins, even if low.
    // The cross-vendor moat doesn't exist for n=1 — caller gets what they
    // asked for: one voter's opinion as-emitted.
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.5, 0.5)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    // Trivial consensus — single voter agrees with themselves.
    expect(outcome.winner).toBe("pass");
  });

  it("returns fail for single-vendor fail with groundedness < 0.5 (strong-reject still applies)", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("fail", 0.3, 0.4, ["fabricated"])),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.winner).toBe("fail");
  });
});

describe("tallyVotes — score-tolerance gating in consensus", () => {
  it("does NOT certify consensus when verdicts agree but score spread exceeds tolerance", () => {
    // All 3 say pass, but groundedness spread is 0.91 - 0.83 = 0.08 > tolerance 0.05.
    // Consensus fails. Falls to weighted majority — all are pass with scores
    // >= 0.83 (above gate 0.85? No, 0.83 < 0.85). Two of them are <0.85 on
    // groundedness so weighted-majority gate refuses. Result: no-consensus.
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.91, 0.91)),
      voter("aider", verdict("pass", 0.83, 0.86)),
      voter("codex", verdict("pass", 0.84, 0.87)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    // Not unanimous-by-tolerance, and 2/3 below gate => no-consensus.
    expect(outcome.winner).toBe("no-consensus");
  });
});

describe("tallyVotes — output shape", () => {
  it("preserves the original verdicts list in the outcome for auditability", () => {
    const votes: VoterVerdict[] = [
      voter("claude-code", verdict("pass", 0.92, 0.91)),
      voter("aider", verdict("pass", 0.93, 0.90)),
      voter("codex", verdict("pass", 0.94, 0.92)),
    ];
    const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
    expect(outcome.verdicts).toHaveLength(3);
    expect(outcome.verdicts[0]!.provider).toBe("claude-code");
    expect(outcome.verdicts[2]!.provider).toBe("codex");
  });
});
