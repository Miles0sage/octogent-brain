// retry-policy.ts — classifies dispatcher transport failures and runs a
// pipeline-budgeted retry loop. Scoped to Codex for v0.3 because that is
// the CLI we've seen hit external quota mid-pipeline. The classifier is
// pattern-driven (vendor error strings are not stable contracts) so add
// known signatures rather than guess at unknown shapes.

import type { SpawnResult } from "./spawn-helper";

export type RetryReason =
  | "quota_exceeded"
  | "rate_limited"
  | "transient_network"
  | "fatal";

export interface ClassifiedFailure {
  reason: RetryReason;
  retryable: boolean;
  retryAfter: Date | null;
  message: string;
}

const RETRY_AFTER_PATTERNS: RegExp[] = [
  /retry (?:available |at |after )?(?:on |at )?([A-Z][a-z]+\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:\d{2}(?:\s*[APap][Mm])?(?:\s+UTC)?)/i,
  /retry-after:\s*(\d+)\s*(?:seconds?|s)?/i,
  /try again (?:at|in)\s+([^.\n]+)/i,
];

const QUOTA_PATTERNS: RegExp[] = [
  /usage\s*cap/i,
  /quota\s*exceed/i,
  /credit\s*(?:exhaust|limit)/i,
  /monthly\s*limit/i,
];

const RATE_LIMIT_PATTERNS: RegExp[] = [
  /rate[\s-]?limit/i,
  /\b429\b/,
  /too many requests/i,
];

function parseRetryAfter(text: string, now: Date): Date | null {
  for (const re of RETRY_AFTER_PATTERNS) {
    const match = re.exec(text);
    if (!match || !match[1]) continue;
    const raw = match[1].trim();

    if (/^\d+$/.test(raw)) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds > 0 && seconds < 7 * 24 * 3600) {
        return new Date(now.getTime() + seconds * 1000);
      }
      continue;
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

export function classifyCodexFailure(
  result: SpawnResult,
  now: Date = new Date()
): ClassifiedFailure {
  const combined = `${result.stderr}\n${result.stdout}`.slice(0, 4000);
  const retryAfter = parseRetryAfter(combined, now);

  if (result.timedOut) {
    return {
      reason: "transient_network",
      retryable: true,
      retryAfter: null,
      message: `timed out after ${result.durationMs}ms`,
    };
  }

  if (QUOTA_PATTERNS.some((re) => re.test(combined))) {
    return {
      reason: "quota_exceeded",
      retryable: false,
      retryAfter,
      message: "vendor quota exceeded",
    };
  }

  if (RATE_LIMIT_PATTERNS.some((re) => re.test(combined))) {
    const cooldownMs = retryAfter ? retryAfter.getTime() - now.getTime() : 0;
    return {
      reason: "rate_limited",
      retryable: cooldownMs <= 60_000,
      retryAfter,
      message: "vendor rate-limited",
    };
  }

  if (result.exitCode === -1 || result.signal != null) {
    return {
      reason: "transient_network",
      retryable: true,
      retryAfter: null,
      message: "spawn-level failure",
    };
  }

  return {
    reason: "fatal",
    retryable: false,
    retryAfter,
    message: "non-retryable transport failure",
  };
}

export interface RetryOpts {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  budgetMs?: number;
  classify: (result: SpawnResult) => ClassifiedFailure;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  jitter?: () => number;
}

export interface RetryOutcome {
  result: SpawnResult;
  attempts: number;
  classification: ClassifiedFailure | null;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

export async function withRetry(
  run: () => Promise<SpawnResult>,
  opts: RetryOpts
): Promise<RetryOutcome> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 8000;
  const budgetMs = opts.budgetMs ?? 30_000;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const jitter = opts.jitter ?? (() => 0.75 + Math.random() * 0.5);

  const startedAt = now();
  let lastResult: SpawnResult | null = null;
  let lastClassification: ClassifiedFailure | null = null;
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    const result = await run();
    lastResult = result;

    if (!result.timedOut && result.exitCode === 0) {
      return { result, attempts: attempt, classification: null };
    }

    const classification = opts.classify(result);
    lastClassification = classification;

    if (!classification.retryable || attempt >= maxAttempts) break;

    const elapsedMs = now() - startedAt;
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * jitter();
    if (elapsedMs + delay > budgetMs) break;

    await sleep(delay);
  }

  return {
    result: lastResult ?? ({
      stdout: "",
      stderr: "",
      exitCode: -1,
      signal: null,
      timedOut: false,
      durationMs: 0,
    } satisfies SpawnResult),
    attempts: attempt,
    classification: lastClassification,
  };
}

export function describeClassification(c: ClassifiedFailure): string {
  if (!c.retryAfter) return c.message;
  return `${c.message} (retry after ${c.retryAfter.toISOString()})`;
}
