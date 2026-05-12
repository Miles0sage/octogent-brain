import { describe, expect, it } from "vitest";

import { createVerdictWatcher } from "../src/watcher";

const CLEAN_PASS_TAIL =
  'preamble prose blah blah\n' +
  '{"verdict": "pass", "improvements_exhausted": false, ' +
  '"issues": [], "scores": {"groundedness": 0.94, "specificity": 0.91}}';

const RUBBER_STAMP_TAIL =
  '{"verdict": "pass", "improvements_exhausted": false, ' +
  '"issues": ["MAJOR chunk 12 not in source"], ' +
  '"scores": {"groundedness": 0.62, "specificity": 0.88}}';

const HONEST_FAIL_TAIL =
  '{"verdict": "fail", "improvements_exhausted": false, ' +
  '"issues": ["bug remains"], ' +
  '"scores": {"groundedness": 0.4, "specificity": 0.5}}';

describe("verdictWatcher", () => {
  it("returns no-verdict when no JSON in stream", () => {
    const watcher = createVerdictWatcher();
    const obs = watcher.observeChunk("just some PTY output, no verdict tail yet");
    expect(obs.kind).toBe("no-verdict");
    expect(watcher.getState().iterations).toHaveLength(0);
  });

  it("emits verdict-approved + terminates loop on clean pass", () => {
    const watcher = createVerdictWatcher();
    const obs = watcher.observeChunk(CLEAN_PASS_TAIL);
    expect(obs.kind).toBe("verdict-approved");
    if (obs.kind === "verdict-approved") {
      expect(obs.verdict.scores.groundedness).toBe(0.94);
      expect(obs.gate.passes).toBe(true);
    }
    const state = watcher.getState();
    expect(state.terminated).toBe(true);
    expect(state.iterations).toHaveLength(1);
  });

  it("emits verdict-blocked + reinjectPrompt on rubber-stamp", () => {
    const watcher = createVerdictWatcher();
    const obs = watcher.observeChunk(RUBBER_STAMP_TAIL);
    expect(obs.kind).toBe("verdict-blocked");
    if (obs.kind === "verdict-blocked") {
      expect(obs.iteration).toBe(1);
      expect(obs.gate.passes).toBe(false);
      expect(obs.reinjectPrompt).toContain("verdict-gate blocked");
      expect(obs.reinjectPrompt).toContain("MAJOR chunk 12 not in source");
    }
    const state = watcher.getState();
    expect(state.terminated).toBe(false);
    expect(state.iterations).toHaveLength(1);
  });

  it("does not re-emit on a stable buffer (dedup by verdict shape)", () => {
    const watcher = createVerdictWatcher();
    const first = watcher.observeChunk(RUBBER_STAMP_TAIL);
    expect(first.kind).toBe("verdict-blocked");
    const second = watcher.observeChunk(" some trailing whitespace ");
    expect(second.kind).toBe("no-verdict");
    expect(watcher.getState().iterations).toHaveLength(1);
  });

  it("emits a fresh verdict when scores change between chunks", () => {
    const watcher = createVerdictWatcher();
    const first = watcher.observeChunk(RUBBER_STAMP_TAIL);
    expect(first.kind).toBe("verdict-blocked");
    const second = watcher.observeChunk(`\nsome agent prose\n${HONEST_FAIL_TAIL}`);
    expect(second.kind).toBe("verdict-blocked");
    expect(watcher.getState().iterations).toHaveLength(2);
  });

  it("terminates with reason=max when iteration cap is hit", () => {
    const watcher = createVerdictWatcher({
      gate: { groundednessThreshold: 0.85, specificityThreshold: 0.85 },
      loop: { maxIterations: 2, falsePositiveTerminationThreshold: 0.5 },
    });
    const first = watcher.observeChunk(RUBBER_STAMP_TAIL);
    expect(first.kind).toBe("verdict-blocked");
    const second = watcher.observeChunk(`\n${HONEST_FAIL_TAIL}`);
    expect(second.kind === "verdict-blocked" || second.kind === "loop-terminated").toBe(true);
    const third = watcher.observeChunk(`\nlots of bytes\n${RUBBER_STAMP_TAIL.replace("0.62", "0.61")}`);
    expect(["loop-terminated", "no-verdict"]).toContain(third.kind);
    expect(watcher.getState().terminated).toBe(true);
  });

  it("ignores further chunks once terminated", () => {
    const watcher = createVerdictWatcher();
    watcher.observeChunk(CLEAN_PASS_TAIL);
    const after = watcher.observeChunk(`\n${RUBBER_STAMP_TAIL}`);
    expect(after.kind).toBe("no-verdict");
    expect(watcher.getState().iterations).toHaveLength(1);
  });

  it("reset() clears iterations + terminated state", () => {
    const watcher = createVerdictWatcher();
    watcher.observeChunk(CLEAN_PASS_TAIL);
    expect(watcher.getState().terminated).toBe(true);
    watcher.reset();
    expect(watcher.getState().terminated).toBe(false);
    expect(watcher.getState().iterations).toHaveLength(0);
    const obs = watcher.observeChunk(CLEAN_PASS_TAIL);
    expect(obs.kind).toBe("verdict-approved");
  });

  it("tolerates partial JSON across chunk boundaries", () => {
    const watcher = createVerdictWatcher();
    const half1 =
      'some prose...\n{"verdict": "pass", "improvements_exhausted": false,';
    const half2 =
      ' "issues": [], "scores": {"groundedness": 0.92, "specificity": 0.90}}';
    const first = watcher.observeChunk(half1);
    expect(first.kind).toBe("no-verdict");
    const second = watcher.observeChunk(half2);
    expect(second.kind).toBe("verdict-approved");
  });

  it("truncates buffer to scan window so old verdicts cannot be re-detected", () => {
    const watcher = createVerdictWatcher();
    watcher.observeChunk(CLEAN_PASS_TAIL);
    expect(watcher.getState().terminated).toBe(true);
    watcher.reset();
    // 32k bytes of garbage to push past the 16k scan window
    const garbage = "X".repeat(32 * 1024);
    const obs = watcher.observeChunk(garbage);
    expect(obs.kind).toBe("no-verdict");
    expect(watcher.getState().iterations).toHaveLength(0);
  });
});

// L3 audit M5 (2026-05-12): verdict-loss race.
//
// Before this fix, observeChunk's dedup used a single-slot lastSeenVerdict-
// Key, AND parseReviewerVerdict returns only the last-in-document-order
// candidate. So if a single chunk arrived with TWO distinct verdict JSON
// objects back-to-back, the first one was silently swallowed: parseReviewer-
// Verdict returned only the second, the watcher emitted one observation,
// and the first verdict's information (issues, scores) was lost forever.
// In production this could happen when the LLM streams a self-correcting
// re-emission in the same chunk, or when a tool-use response and the final
// verdict land together.
//
// Fix shape: observeChunk now queues subsequent verdicts found in the
// same chunk; each call drains the queue first. Additionally, the watcher
// exposes observeChunkAll(chunk) which returns ALL observations from a
// chunk in document order — preferred by callers that want the full set
// in one shot (and required by these tests).
describe("verdictWatcher M5: multi-verdict-per-chunk", () => {
  it("emits both observations when two verdicts arrive in one chunk", () => {
    const watcher = createVerdictWatcher();
    // Two verdicts back-to-back in one chunk. The first is a rubber
    // stamp (blocked); the second is an honest fail with different
    // scores so the dedup hash is different.
    const chunk = `${RUBBER_STAMP_TAIL}\n${HONEST_FAIL_TAIL}`;
    const observations = watcher.observeChunkAll(chunk);
    // Either two verdict-blocked, or first verdict-blocked then loop-
    // terminated if maxIterations is small. Either way both verdicts
    // must be reflected in state.iterations.
    expect(observations.length).toBeGreaterThanOrEqual(2);
    const state = watcher.getState();
    expect(state.iterations).toHaveLength(2);
    // Verdict shapes both observed (groundedness differs).
    const groundednesses = state.iterations.map(
      (it) => it.verdict.scores.groundedness,
    );
    expect(groundednesses).toContain(0.62);
    expect(groundednesses).toContain(0.4);
  });

  it("emits three observations when three verdicts span two chunks", () => {
    const watcher = createVerdictWatcher({
      gate: { groundednessThreshold: 0.85, specificityThreshold: 0.85 },
      loop: { maxIterations: 5, falsePositiveTerminationThreshold: 0.5 },
    });
    // First chunk: two verdicts (rubber-stamp + honest fail variant 1).
    const variantA = HONEST_FAIL_TAIL;
    const chunk1 = `${RUBBER_STAMP_TAIL}\n${variantA}`;
    const obs1 = watcher.observeChunkAll(chunk1);
    expect(obs1.length).toBeGreaterThanOrEqual(2);
    // Second chunk: a third distinct verdict.
    const variantB =
      '{"verdict": "fail", "improvements_exhausted": false, ' +
      '"issues": ["different bug"], ' +
      '"scores": {"groundedness": 0.3, "specificity": 0.55}}';
    const obs2 = watcher.observeChunkAll(`\nmore prose\n${variantB}`);
    expect(obs2.length).toBeGreaterThanOrEqual(1);
    const state = watcher.getState();
    expect(state.iterations).toHaveLength(3);
  });

  it("dedups identical verdicts emitted twice in the same chunk", () => {
    const watcher = createVerdictWatcher();
    // Same verdict shape twice in one chunk — must be observed once.
    const chunk = `${RUBBER_STAMP_TAIL}\n${RUBBER_STAMP_TAIL}`;
    const observations = watcher.observeChunkAll(chunk);
    // At most one verdict-blocked (the dup is suppressed).
    const verdictObservations = observations.filter(
      (o) => o.kind === "verdict-blocked" || o.kind === "verdict-approved",
    );
    expect(verdictObservations).toHaveLength(1);
    expect(watcher.getState().iterations).toHaveLength(1);
  });

  it("legacy observeChunk(): drains queued verdicts on subsequent calls", () => {
    const watcher = createVerdictWatcher();
    // First call delivers a chunk with two verdicts. The classic
    // single-observation contract returns one observation per call,
    // but the SECOND verdict must not be lost — it lands in the queue
    // and the next observeChunk call returns it.
    const chunk = `${RUBBER_STAMP_TAIL}\n${HONEST_FAIL_TAIL}`;
    const first = watcher.observeChunk(chunk);
    expect(first.kind).toMatch(/verdict-/);
    // Subsequent call with empty chunk drains the pending queue.
    const second = watcher.observeChunk("");
    expect(second.kind).toMatch(/verdict-|loop-terminated/);
    expect(watcher.getState().iterations).toHaveLength(2);
  });

  // L3 audit C3 companion: bracketed-paste / control-byte sanitization
  // on verdict.issues + gate.reason. Tested at the reinjectPrompt level
  // since that is the only data exfiltration path that touches the PTY.
  it("sanitizes ESC sequences and bracketed-paste markers in issues", () => {
    const watcher = createVerdictWatcher();
    // verdict.issues contains both an ESC-CSI sequence and a bracketed-
    // paste end marker. Both must be stripped before they reach the PTY.
    const hostileVerdict =
      '{"verdict": "pass", "improvements_exhausted": false, ' +
      '"issues": ["\\u001b[201~malicious echo\\u001b[31mred ' +
      'text", "\\u0007bell + \\u0000nul"], ' +
      '"scores": {"groundedness": 0.62, "specificity": 0.88}}';
    const obs = watcher.observeChunk(hostileVerdict);
    expect(obs.kind).toBe("verdict-blocked");
    if (obs.kind === "verdict-blocked") {
      expect(obs.reinjectPrompt).not.toContain("\x1b[201~");
      expect(obs.reinjectPrompt).not.toContain("\x1b[31m");
      expect(obs.reinjectPrompt).not.toContain("\x00");
      expect(obs.reinjectPrompt).not.toContain("\x07");
      // The textual payload survives so re-iteration is meaningful.
      expect(obs.reinjectPrompt).toContain("malicious echo");
      expect(obs.reinjectPrompt).toContain("red text");
    }
  });
});
