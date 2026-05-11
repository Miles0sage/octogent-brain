// Cross-vendor voting primitive — the moat.
//
// NotebookLM 2026-05-11 round-3 + agency-swarm round-1 synthesis: Anthropic
// structurally cannot ship cross-vendor routing because it cannibalizes
// Claude API revenue. The defensible 60-day play is "ship the same task to
// N CLIs in parallel + pick the winner mechanically by consensus." This
// module is the mechanical picker — pure-TS, no I/O, no Date.now(), no
// fetch. Wire it to the dispatcher from the API layer.
//
// Precedence rules (in evaluation order):
//   1. CONSENSUS         — all voters agree on `verdict` AND scores within
//                          configured tolerance. The agreed verdict wins.
//   2. STRONG-REJECT     — any single voter returns "fail" with
//                          groundedness < strongRejectGroundedness. Returns
//                          "fail" regardless of other votes. Security-first.
//   3. WEIGHTED MAJORITY — strict majority (count > N/2) say "pass" with
//                          scores meeting the gate thresholds => "pass". Or
//                          strict majority say "fail" => "fail".
//   4. NO-CONSENSUS      — everything else (ties, all-null, empty, low
//                          weighted-majority confidence, score spread that
//                          breaks consensus + no strict majority).

import type { ReviewerVerdict } from "@octogent/core";

export type VoterVerdict = {
  provider: string;
  verdict: ReviewerVerdict | null;
  raw_output: string;
  error?: string;
};

export type VoteOutcome = {
  winner: "pass" | "fail" | "no-consensus";
  reason: string;
  consensus_count: number;
  dissent_count: number;
  verdicts: ReadonlyArray<VoterVerdict>;
};

export type VoteConfig = {
  // Gate thresholds applied to weighted-majority "pass" outcomes. A
  // majority-pass with average groundedness/specificity below these
  // thresholds collapses to no-consensus rather than rubber-stamping.
  groundednessThreshold: number;
  specificityThreshold: number;
  // Max allowable spread (max - min) across voters for both groundedness
  // and specificity when checking unanimous consensus. Tight tolerance =
  // strict consensus.
  consensusToleranceForScores: number;
  // Any voter returning "fail" with groundedness STRICTLY less than this
  // value triggers a strong-reject override. Strict `<` — a fail at the
  // exact threshold does NOT trigger strong-reject.
  strongRejectGroundedness: number;
};

export const DEFAULT_VOTE_CONFIG: VoteConfig = {
  groundednessThreshold: 0.85,
  specificityThreshold: 0.85,
  consensusToleranceForScores: 0.05,
  strongRejectGroundedness: 0.5,
};

// Returns voters that emitted a parseable verdict. The unparsed ones are
// retained on the outcome (for auditability) but skipped by the tally.
const filterParsed = (
  verdicts: ReadonlyArray<VoterVerdict>,
): ReadonlyArray<VoterVerdict & { verdict: ReviewerVerdict }> =>
  verdicts.filter(
    (v): v is VoterVerdict & { verdict: ReviewerVerdict } => v.verdict !== null,
  );

const spread = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0;
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return max - min;
};

const checkConsensus = (
  parsed: ReadonlyArray<VoterVerdict & { verdict: ReviewerVerdict }>,
  config: VoteConfig,
): "pass" | "fail" | null => {
  if (parsed.length === 0) return null;
  const first = parsed[0]!.verdict.verdict;
  for (const v of parsed) {
    if (v.verdict.verdict !== first) return null;
  }
  const groundedness = parsed.map((v) => v.verdict.scores.groundedness);
  const specificity = parsed.map((v) => v.verdict.scores.specificity);
  if (spread(groundedness) > config.consensusToleranceForScores) return null;
  if (spread(specificity) > config.consensusToleranceForScores) return null;
  return first;
};

const findStrongReject = (
  parsed: ReadonlyArray<VoterVerdict & { verdict: ReviewerVerdict }>,
  config: VoteConfig,
): (VoterVerdict & { verdict: ReviewerVerdict }) | null => {
  for (const v of parsed) {
    if (
      v.verdict.verdict === "fail" &&
      v.verdict.scores.groundedness < config.strongRejectGroundedness
    ) {
      return v;
    }
  }
  return null;
};

const countBy = <T>(items: ReadonlyArray<T>, pred: (t: T) => boolean): number =>
  items.reduce((n, t) => (pred(t) ? n + 1 : n), 0);

const average = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
};

export const tallyVotes = (
  verdicts: ReadonlyArray<VoterVerdict>,
  config: VoteConfig,
): VoteOutcome => {
  if (verdicts.length === 0) {
    return {
      winner: "no-consensus",
      reason: "no voters submitted",
      consensus_count: 0,
      dissent_count: 0,
      verdicts,
    };
  }

  const parsed = filterParsed(verdicts);
  if (parsed.length === 0) {
    return {
      winner: "no-consensus",
      reason: "no parseable verdicts (all voters emitted unparseable output)",
      consensus_count: 0,
      dissent_count: 0,
      verdicts,
    };
  }

  // Rule 1: unanimous consensus on verdict + tight score spread.
  const consensus = checkConsensus(parsed, config);
  if (consensus !== null) {
    return {
      winner: consensus,
      reason: `consensus: all ${parsed.length} voter(s) agreed on ${consensus} (score spread within tolerance ${config.consensusToleranceForScores})`,
      consensus_count: parsed.length,
      dissent_count: 0,
      verdicts,
    };
  }

  // Rule 2: strong-reject (loudest dissent) — security-first override.
  const strongReject = findStrongReject(parsed, config);
  if (strongReject !== null) {
    const dissent = countBy(parsed, (v) => v.verdict.verdict !== "fail");
    return {
      winner: "fail",
      reason: `strong-reject: provider=${strongReject.provider} returned fail with groundedness=${strongReject.verdict.scores.groundedness} < threshold=${config.strongRejectGroundedness}`,
      consensus_count: countBy(parsed, (v) => v.verdict.verdict === "fail"),
      dissent_count: dissent,
      verdicts,
    };
  }

  // Rule 3: weighted majority. Strict majority required (count > N/2).
  const passCount = countBy(parsed, (v) => v.verdict.verdict === "pass");
  const failCount = countBy(parsed, (v) => v.verdict.verdict === "fail");
  const total = parsed.length;
  const majorityNeeded = Math.floor(total / 2) + 1;

  if (passCount >= majorityNeeded) {
    // Per-voter gate: count voters whose pass came with scores meeting BOTH
    // thresholds. We require a strict majority of *qualified* passers, not
    // just any passers — a 2/3 majority where only one passer met the gate
    // is rubber-stamping by another name.
    const qualifiedPassers = parsed.filter(
      (v) =>
        v.verdict.verdict === "pass" &&
        v.verdict.scores.groundedness >= config.groundednessThreshold &&
        v.verdict.scores.specificity >= config.specificityThreshold,
    );
    if (qualifiedPassers.length >= majorityNeeded) {
      const avgGround = average(qualifiedPassers.map((v) => v.verdict.scores.groundedness));
      const avgSpec = average(qualifiedPassers.map((v) => v.verdict.scores.specificity));
      return {
        winner: "pass",
        reason: `weighted-majority: ${qualifiedPassers.length}/${total} voted pass with scores >= gate (avg groundedness=${avgGround.toFixed(3)}, avg specificity=${avgSpec.toFixed(3)})`,
        consensus_count: qualifiedPassers.length,
        dissent_count: total - qualifiedPassers.length,
        verdicts,
      };
    }
    return {
      winner: "no-consensus",
      reason: `weighted-majority insufficient: ${passCount}/${total} voted pass but only ${qualifiedPassers.length} met the score gate (groundedness>=${config.groundednessThreshold}, specificity>=${config.specificityThreshold})`,
      consensus_count: passCount,
      dissent_count: total - passCount,
      verdicts,
    };
  }

  if (failCount >= majorityNeeded) {
    return {
      winner: "fail",
      reason: `weighted-majority: ${failCount}/${total} voted fail`,
      consensus_count: failCount,
      dissent_count: total - failCount,
      verdicts,
    };
  }

  // Rule 4: no majority, no consensus, no strong reject.
  return {
    winner: "no-consensus",
    reason: `split decision: ${passCount} pass / ${failCount} fail across ${total} voter(s); no strict majority, no consensus, no strong reject`,
    consensus_count: 0,
    dissent_count: total,
    verdicts,
  };
};
