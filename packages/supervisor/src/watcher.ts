// Verdict watcher — wires packages/core verdict-gate + review-fix-loop
// into the live PTY runtime. When enabled on a session, the watcher scans
// every stdout chunk for a final-line JSON verdict (Hosico02 pattern),
// runs it through evaluateVerdict + decideNext, and tells the caller
// whether to re-inject a re-iteration prompt or let the agent finish.
//
// Rationale: NotebookLM strategic synthesis 2026-05-11 — "Operationalize
// the pure-TS verdict-gate by wiring it directly into the existing
// node-pty dispatcher. When the orchestrator mechanically blocks a
// hallucinated pass, the Gantt visually drops a BLOCK node, proving
// the loop cannot be rubber-stamped."

import {
  DEFAULT_GATE_CONFIG,
  DEFAULT_REVIEW_FIX_LOOP_CONFIG,
  decideNext,
  evaluateVerdict,
  parseReviewerVerdict,
  type GateConfig,
  type GateDecision,
  type LoopDecision,
  type LoopIteration,
  type ReviewFixLoopConfig,
  type ReviewerVerdict,
} from "@octogent/core";

// Scrollback window scanned for a verdict tail. 16k is large enough to
// catch even prose-wrapped JSON yet small enough that the parser stays
// cheap on every chunk arrival.
const SCAN_WINDOW_BYTES = 16 * 1024;

export type VerdictWatcherConfig = {
  gate: GateConfig;
  loop: ReviewFixLoopConfig;
  // Maximum iterations the watcher is allowed to inject before giving
  // up and emitting the terminal "max-iterations" decision. Defaults to
  // loop.maxIterations.
  maxAutoIterations?: number;
};

export type VerdictWatcherState = {
  iterations: ReadonlyArray<LoopIteration>;
  latestDecision: LoopDecision | null;
  latestGate: GateDecision | null;
  latestVerdict: ReviewerVerdict | null;
  // True once decideNext returned approve / max / fp — the watcher will
  // not act on further verdicts after this.
  terminated: boolean;
};

export type WatcherObservation =
  | { kind: "no-verdict" }
  | { kind: "verdict-approved"; verdict: ReviewerVerdict; gate: GateDecision }
  | {
      kind: "verdict-blocked";
      verdict: ReviewerVerdict;
      gate: GateDecision;
      reinjectPrompt: string;
      iteration: number;
    }
  | {
      kind: "loop-terminated";
      reason: "max" | "fp";
      iterations: ReadonlyArray<LoopIteration>;
    };

export type VerdictWatcher = {
  observeChunk(chunk: string): WatcherObservation;
  getState(): VerdictWatcherState;
  reset(): void;
};

const truncatedTail = (buffer: string): string =>
  buffer.length <= SCAN_WINDOW_BYTES
    ? buffer
    : buffer.slice(buffer.length - SCAN_WINDOW_BYTES);

const buildReinjectPrompt = (verdict: ReviewerVerdict, gate: GateDecision): string => {
  const issuesBlock =
    verdict.issues.length === 0
      ? "(no specific issues reported)"
      : verdict.issues.map((issue, idx) => `${idx + 1}. ${issue}`).join("\n");
  return [
    `[verdict-gate blocked: ${gate.reason}]`,
    "Your prior verdict was overridden — the gate-trust-numbers rule kicked in.",
    "Iterate on the underlying work to address these issues, then emit a stronger",
    "verdict JSON with truthful scores.",
    "",
    "Issues to address:",
    issuesBlock,
    "",
    "Re-emit the final-line JSON verdict when done.",
  ].join("\n");
};

export const createVerdictWatcher = (
  config: VerdictWatcherConfig = {
    gate: DEFAULT_GATE_CONFIG,
    loop: DEFAULT_REVIEW_FIX_LOOP_CONFIG,
  },
): VerdictWatcher => {
  let buffer = "";
  let lastSeenVerdictKey = "";
  const iterations: LoopIteration[] = [];
  let terminated = false;
  let latestDecision: LoopDecision | null = null;
  let latestGate: GateDecision | null = null;
  let latestVerdict: ReviewerVerdict | null = null;

  const maxIters = config.maxAutoIterations ?? config.loop.maxIterations;

  const observeChunk = (chunk: string): WatcherObservation => {
    if (terminated) {
      return { kind: "no-verdict" };
    }

    buffer = truncatedTail(buffer + chunk);

    const verdict = parseReviewerVerdict(buffer);
    if (verdict === null) {
      return { kind: "no-verdict" };
    }

    // Dedupe identical verdicts within the same scan window — the parser
    // walks the tail every chunk, so a stable verdict at the tip will
    // re-parse identical until new bytes shift it. Hashing the verdict
    // shape lets us emit it exactly once per actual emission.
    const verdictKey = JSON.stringify(verdict);
    if (verdictKey === lastSeenVerdictKey) {
      return { kind: "no-verdict" };
    }
    lastSeenVerdictKey = verdictKey;

    const gate = evaluateVerdict(verdict, config.gate);
    latestVerdict = verdict;
    latestGate = gate;

    const nextIteration: LoopIteration = {
      iter: iterations.length + 1,
      verdict,
      gatePassed: gate.passes,
    };
    iterations.push(nextIteration);

    const decision = decideNext(iterations, config.loop);
    latestDecision = decision;

    if (decision.action === "approve") {
      terminated = true;
      return { kind: "verdict-approved", verdict, gate };
    }

    if (decision.action === "max" || decision.action === "fp") {
      terminated = true;
      return {
        kind: "loop-terminated",
        reason: decision.action,
        iterations,
      };
    }

    // decision.action === "continue" — gate failed, force re-iteration
    // unless we've already exceeded the auto-inject cap.
    if (iterations.length >= maxIters) {
      terminated = true;
      return {
        kind: "loop-terminated",
        reason: "max",
        iterations,
      };
    }

    return {
      kind: "verdict-blocked",
      verdict,
      gate,
      reinjectPrompt: buildReinjectPrompt(verdict, gate),
      iteration: nextIteration.iter,
    };
  };

  const getState = (): VerdictWatcherState => ({
    iterations,
    latestDecision,
    latestGate,
    latestVerdict,
    terminated,
  });

  const reset = (): void => {
    buffer = "";
    lastSeenVerdictKey = "";
    iterations.length = 0;
    terminated = false;
    latestDecision = null;
    latestGate = null;
    latestVerdict = null;
  };

  return { observeChunk, getState, reset };
};
