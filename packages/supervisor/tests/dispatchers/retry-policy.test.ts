import { describe, expect, it, vi } from "vitest";

import {
  classifyCodexFailure,
  describeClassification,
  withRetry,
} from "../../src/dispatchers/retry-policy";
import type { SpawnResult } from "../../src/dispatchers/spawn-helper";

const FIXED_NOW = new Date("2026-05-12T20:00:00.000Z");

const makeResult = (overrides: Partial<SpawnResult> = {}): SpawnResult => ({
  stdout: "",
  stderr: "",
  exitCode: 1,
  signal: null,
  timedOut: false,
  durationMs: 100,
  ...overrides,
});

describe("classifyCodexFailure", () => {
  it("flags vendor quota cap as non-retryable and parses absolute retry-after", () => {
    const result = makeResult({
      stderr:
        "ERROR: usage cap reached for chatgpt account. Retry available at May 13, 2026 2:13 AM UTC.",
    });
    const c = classifyCodexFailure(result, FIXED_NOW);
    expect(c.reason).toBe("quota_exceeded");
    expect(c.retryable).toBe(false);
    expect(c.retryAfter).toBeInstanceOf(Date);
    expect(c.retryAfter?.toISOString()).toBe("2026-05-13T02:13:00.000Z");
  });

  it("flags 429 rate-limit with short cooldown as retryable", () => {
    const result = makeResult({
      stderr: "HTTP 429 rate-limited; retry-after: 15 seconds",
    });
    const c = classifyCodexFailure(result, FIXED_NOW);
    expect(c.reason).toBe("rate_limited");
    expect(c.retryable).toBe(true);
    expect(c.retryAfter?.getTime()).toBe(FIXED_NOW.getTime() + 15_000);
  });

  it("flags rate-limit with long cooldown as not retryable", () => {
    const result = makeResult({
      stderr: "Rate limit exceeded. Retry-After: 600 seconds.",
    });
    const c = classifyCodexFailure(result, FIXED_NOW);
    expect(c.reason).toBe("rate_limited");
    expect(c.retryable).toBe(false);
  });

  it("flags timeout as retryable transient", () => {
    const result = makeResult({ timedOut: true, durationMs: 180_000 });
    const c = classifyCodexFailure(result, FIXED_NOW);
    expect(c.reason).toBe("transient_network");
    expect(c.retryable).toBe(true);
    expect(c.retryAfter).toBeNull();
  });

  it("flags exit -1 spawn-level failure as retryable transient", () => {
    const result = makeResult({ exitCode: -1, stderr: "spawn ENOENT" });
    const c = classifyCodexFailure(result, FIXED_NOW);
    expect(c.reason).toBe("transient_network");
    expect(c.retryable).toBe(true);
  });

  it("flags unknown errors as fatal (not retryable)", () => {
    const result = makeResult({ stderr: "invalid argument" });
    const c = classifyCodexFailure(result, FIXED_NOW);
    expect(c.reason).toBe("fatal");
    expect(c.retryable).toBe(false);
  });
});

describe("describeClassification", () => {
  it("appends retry-after ISO when present", () => {
    const text = describeClassification({
      reason: "quota_exceeded",
      retryable: false,
      retryAfter: new Date("2026-05-13T02:13:00.000Z"),
      message: "vendor quota exceeded",
    });
    expect(text).toBe("vendor quota exceeded (retry after 2026-05-13T02:13:00.000Z)");
  });

  it("omits retry-after when absent", () => {
    const text = describeClassification({
      reason: "fatal",
      retryable: false,
      retryAfter: null,
      message: "non-retryable transport failure",
    });
    expect(text).toBe("non-retryable transport failure");
  });
});

describe("withRetry", () => {
  it("returns immediately on first success", async () => {
    const run = vi.fn().mockResolvedValue(
      makeResult({ exitCode: 0, stdout: "ok" })
    );
    const out = await withRetry(run, {
      classify: () => ({
        reason: "fatal",
        retryable: false,
        retryAfter: null,
        message: "n/a",
      }),
      sleep: vi.fn().mockResolvedValue(undefined),
      jitter: () => 1,
    });
    expect(out.attempts).toBe(1);
    expect(out.classification).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("retries up to maxAttempts when classified retryable", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce(makeResult({ stderr: "rate-limited" }))
      .mockResolvedValueOnce(makeResult({ stderr: "rate-limited" }))
      .mockResolvedValueOnce(makeResult({ exitCode: 0 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await withRetry(run, {
      maxAttempts: 3,
      baseDelayMs: 10,
      classify: () => ({
        reason: "rate_limited",
        retryable: true,
        retryAfter: null,
        message: "rl",
      }),
      sleep,
      jitter: () => 1,
    });
    expect(out.attempts).toBe(3);
    expect(out.result.exitCode).toBe(0);
    expect(out.classification).toBeNull();
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("aborts immediately on non-retryable classification", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ stderr: "usage cap" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await withRetry(run, {
      maxAttempts: 3,
      classify: () => ({
        reason: "quota_exceeded",
        retryable: false,
        retryAfter: null,
        message: "quota",
      }),
      sleep,
      jitter: () => 1,
    });
    expect(out.attempts).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(out.classification?.reason).toBe("quota_exceeded");
  });

  it("stops when budgetMs would be exceeded by next backoff", async () => {
    const run = vi.fn().mockResolvedValue(makeResult({ stderr: "rate-limited" }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    let virtualNow = 0;
    const out = await withRetry(run, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 10_000,
      budgetMs: 1500,
      classify: () => ({
        reason: "rate_limited",
        retryable: true,
        retryAfter: null,
        message: "rl",
      }),
      sleep: async (ms: number) => {
        virtualNow += ms;
      },
      now: () => virtualNow,
      jitter: () => 1,
    });
    expect(out.attempts).toBeLessThanOrEqual(2);
    expect(run.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
