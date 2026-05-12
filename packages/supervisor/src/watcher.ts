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
  narrowReviewerVerdict,
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

// L3 audit r2 H2 (2026-05-12): JSON-DoS caps on the verdict extractor.
//
// Threat: an attacker influences agent stdout (prompt injection via task
// description or poisoned RAG doc). The watcher runs `extractAllVerdicts`
// on every chunk; a chunk packed with thousands of balanced JSON
// candidates or one ~8KB deeply-nested candidate stalls the event loop
// inside JSON.parse. Caps:
//
//   MAX_VERDICT_CANDIDATES_PER_CHUNK — bail after this many candidates
//   MAX_CANDIDATE_BYTES — drop any candidate whose byte span exceeds this
//   MAX_VERDICT_NESTING_DEPTH — drop a candidate the moment depth exceeds
const MAX_VERDICT_CANDIDATES_PER_CHUNK = 8;
const MAX_CANDIDATE_BYTES = 4 * 1024;
const MAX_VERDICT_NESTING_DEPTH = 32;

// Bounded, allocation-aware walker for top-level JSON objects in a
// scrollback buffer. Replaces the unrestricted core walker for the
// watcher's hot path. Note: returns ReviewerVerdict[] (narrowed) — the
// caller does not need to revalidate.
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
      if (depth > MAX_VERDICT_NESTING_DEPTH) {
        // Abandon this candidate completely — too deep to parse safely.
        depth = 0;
        start = -1;
      }
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const span = i + 1 - start;
        if (span <= MAX_CANDIDATE_BYTES) {
          candidates.push(buffer.slice(start, i + 1));
          if (candidates.length >= MAX_VERDICT_CANDIDATES_PER_CHUNK) break;
        }
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  const out: ReviewerVerdict[] = [];
  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const narrowed = narrowReviewerVerdict(parsed);
    if (narrowed) out.push(narrowed);
  }
  return out;
};

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
// L3 audit r2 L1 (2026-05-12): the prior CSI strip required a final
// terminator byte (@-~), so unterminated CSI sequences slipped through
// as visible "[malicious_payload" fragments. The replacement first
// strips well-formed CSI (parameters/intermediates/final), then strips
// any leftover ESC[ prefix with optional parameter / intermediate bytes
// up to the next final byte OR end-of-string. Also strips OSC/DCS/SOS/
// PM/APC introducers and bracketed-paste markers for completeness.
const sanitizeForBracketedPaste = (value: string): string =>
  value
    // Bracketed-paste markers the LLM may have echoed back.
    .replace(/\x1b\[20[01]~/g, "")
    // Well-formed CSI (ESC [ params? intermediates? final-byte).
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    // Unterminated CSI: ESC [ followed by params/intermediates that
    // never hit a final byte. Strip whatever remains up to the next
    // non-CSI byte. Matches "ESC [" + zero-or-more param/intermediate
    // bytes, then an optional final byte if present (already covered).
    .replace(/\x1b\[[\x20-\x3f]*/g, "")
    // Other ESC-introduced control strings: OSC (ESC ]), DCS (ESC P),
    // SOS (ESC X), PM (ESC ^), APC (ESC _). Each can carry payload up
    // to ST (ESC \) or BEL.
    .replace(/\x1b[\]PX^_][^\x07\x1b]*(?:\x1b\\|\x07)?/g, "")
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

// Multi-verdict extraction. The watcher owns the bounded walker above
// (extractAllVerdicts) so the JSON-DoS caps are enforced at the only
// hot path that scans LLM-influenced bytes on every chunk. The shape
// narrowing is delegated to @octogent/core's narrowReviewerVerdict so
// the contract stays single-sourced (L3 audit r2 H2, 2026-05-12).

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
      // Set preserves insertion order. Size > maxIters >= 0 implies
      // the iterator yields a defined first entry — narrow with a cast
      // rather than a runtime undefined guard (L3 audit r2 L2,
      // 2026-05-12).
      const oldest = seenVerdictKeys.values().next().value as string;
      seenVerdictKeys.delete(oldest);
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
