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
//
// L3 audit M5 (2026-05-12): observeChunk previously used a single-slot
// `lastSeenVerdictKey` dedup AND relied on parseReviewerVerdict — which
// returns only the LAST candidate in document order. When two distinct
// verdicts arrived in the same chunk (LLM self-correction, tool-use
// trailer + verdict, etc.), the first was silently dropped. Fix:
//   1. Walk the new-since-last-call slice of the buffer ourselves so we
//      can see every balanced top-level JSON object, in document order.
//   2. Replace single-slot dedup with `seenVerdictKeys: Set<string>`
//      bounded to loop.maxIterations entries (FIFO when full).
//   3. observeChunk keeps the legacy single-observation contract; extra
//      observations land in a queue, drained on subsequent calls.
//   4. observeChunkAll(chunk) — new — returns every observation from a
//      chunk in document order. Preferred for new callers; the PTY
//      runtime listener can migrate at its leisure.

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
  // Legacy contract: returns one observation per call. When a chunk
  // contains multiple new verdicts, the first is returned and the rest
  // are queued; subsequent observeChunk calls (even with `""`) drain
  // the queue before scanning new bytes. Preserved so the live PTY
  // listener in apps/api/src/terminalRuntime/sessionRuntime.ts keeps
  // working without modification.
  observeChunk(chunk: string): WatcherObservation;
  // Preferred new contract: returns every observation produced by a
  // chunk, in document order. Empty array means "nothing happened"
  // (formerly the `no-verdict` single-observation). Drains any queued
  // observations from previous calls before processing the new chunk.
  observeChunkAll(chunk: string): WatcherObservation[];
  getState(): VerdictWatcherState;
  reset(): void;
};

const truncatedTail = (buffer: string): string =>
  buffer.length <= SCAN_WINDOW_BYTES
    ? buffer
    : buffer.slice(buffer.length - SCAN_WINDOW_BYTES);

// The re-inject prompt is written back into the PTY's stdin. LLM-supplied
// content (verdict.issues + gate.reason) may contain control characters,
// bracketed-paste terminators, or shell metacharacters. If the PTY
// receiver is a bare shell (rather than an agent CLI), unsanitized bytes
// could trigger command execution. Strip every ESC sequence + control
// byte; the receiver gets prose text only. Per L3 audit C3 (2026-05-12).
const sanitizeForBracketedPaste = (value: string): string =>
  value
    // Strip any bracketed-paste markers the LLM may have echoed back.
    .replace(/\x1b\[20[01]~/g, "")
    // Strip all CSI escape sequences (ESC [ ... letter).
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Strip C0 controls (NUL through US, except LF and CR) + DEL.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, " ");

const buildReinjectPrompt = (verdict: ReviewerVerdict, gate: GateDecision): string => {
  const safeReason = sanitizeForBracketedPaste(gate.reason);
  const safeIssues = verdict.issues.map(sanitizeForBracketedPaste);
  const issuesBlock =
    safeIssues.length === 0
      ? "(no specific issues reported)"
      : safeIssues.map((issue, idx) => `${idx + 1}. ${issue}`).join("\n");
  return [
    `[verdict-gate blocked: ${safeReason}]`,
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

// Walk a buffer and return every balanced top-level JSON object that
// successfully parses as a ReviewerVerdict, in document order. Mirrors
// the extraction logic in packages/core/src/orchestrator/verdict-gate.ts
// but returns ALL candidates rather than just the last — required for
// L3 M5 multi-verdict-per-chunk handling. Kept private to watcher.ts so
// the core export stays focused on the "final line wins" contract.
const extractAllVerdicts = (buffer: string): ReviewerVerdict[] => {
  const candidates: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        candidates.push(buffer.slice(start, i + 1));
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  const out: ReviewerVerdict[] = [];
  for (const c of candidates) {
    // Round-trip through parseReviewerVerdict so the narrowing logic is
    // shared (verdict literal, scores in [0,1], etc.). We call the
    // single-candidate parser on the isolated JSON string so it picks
    // up exactly that candidate without confusion.
    const parsed = parseReviewerVerdict(c);
    if (parsed !== null) out.push(parsed);
  }
  return out;
};

export const createVerdictWatcher = (
  config: VerdictWatcherConfig = {
    gate: DEFAULT_GATE_CONFIG,
    loop: DEFAULT_REVIEW_FIX_LOOP_CONFIG,
  },
): VerdictWatcher => {
  let buffer = "";
  // L3 M5: replaced the single-slot lastSeenVerdictKey with a Set so
  // multiple distinct verdicts in the same chunk each emit exactly once.
  // Bounded to maxIterations entries — older keys age out in insertion
  // order so the set cannot grow unboundedly over long sessions.
  const seenVerdictKeys = new Set<string>();
  // Pending observations queued for subsequent observeChunk calls so the
  // legacy single-observation contract is preserved while no verdict is
  // ever lost.
  const pendingObservations: WatcherObservation[] = [];
  const iterations: LoopIteration[] = [];
  let terminated = false;
  let latestDecision: LoopDecision | null = null;
  let latestGate: GateDecision | null = null;
  let latestVerdict: ReviewerVerdict | null = null;

  const maxIters = config.maxAutoIterations ?? config.loop.maxIterations;

  // Record a verdict key in the seen set with FIFO eviction so the set
  // stays bounded. maxIters is the natural cap because we can never act
  // on more verdicts than that anyway.
  const recordSeen = (key: string): void => {
    seenVerdictKeys.add(key);
    if (seenVerdictKeys.size > maxIters) {
      // Set preserves insertion order; drop the oldest.
      const oldest = seenVerdictKeys.values().next().value;
      if (oldest !== undefined) seenVerdictKeys.delete(oldest);
    }
  };

  // Process one verdict candidate into its WatcherObservation +
  // possibly terminate the loop. Mirrors the original single-pass
  // logic, but factored out so observeChunkAll can loop over multiple
  // verdicts from one chunk.
  const processVerdict = (verdict: ReviewerVerdict): WatcherObservation => {
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

  // Append the new chunk to the buffer, then return every NEW verdict
  // observation produced. "New" = the verdict's stringified key is not
  // already in seenVerdictKeys. Document order preserved.
  const collectFromChunk = (chunk: string): WatcherObservation[] => {
    if (terminated) return [];
    buffer = truncatedTail(buffer + chunk);
    const verdicts = extractAllVerdicts(buffer);
    const out: WatcherObservation[] = [];
    for (const verdict of verdicts) {
      if (terminated) break;
      const key = JSON.stringify(verdict);
      if (seenVerdictKeys.has(key)) continue;
      recordSeen(key);
      out.push(processVerdict(verdict));
    }
    return out;
  };

  const observeChunkAll = (chunk: string): WatcherObservation[] => {
    // Drain any queue from prior calls first so document order across
    // calls is preserved.
    const drained = pendingObservations.splice(0, pendingObservations.length);
    const fresh = collectFromChunk(chunk);
    return [...drained, ...fresh];
  };

  const observeChunk = (chunk: string): WatcherObservation => {
    // Legacy single-observation contract: drain queue first, else
    // process the chunk and return the first observation while queueing
    // the rest.
    if (pendingObservations.length > 0) {
      const next = pendingObservations.shift();
      // Type narrows away undefined: pendingObservations.length > 0
      // guarantees shift returns a defined entry.
      if (next !== undefined) {
        // Still scan the chunk so we don't miss subsequent verdicts
        // that arrived while a queue entry was pending. Append the
        // results to the queue.
        const fresh = collectFromChunk(chunk);
        if (fresh.length > 0) pendingObservations.push(...fresh);
        return next;
      }
    }
    const observations = collectFromChunk(chunk);
    if (observations.length === 0) {
      return { kind: "no-verdict" };
    }
    const [first, ...rest] = observations;
    if (rest.length > 0) pendingObservations.push(...rest);
    // The destructured first is non-undefined when observations.length > 0.
    return first ?? { kind: "no-verdict" };
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
    seenVerdictKeys.clear();
    pendingObservations.length = 0;
    iterations.length = 0;
    terminated = false;
    latestDecision = null;
    latestGate = null;
    latestVerdict = null;
  };

  return { observeChunk, observeChunkAll, getState, reset };
};
