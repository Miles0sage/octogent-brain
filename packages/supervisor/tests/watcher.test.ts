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
