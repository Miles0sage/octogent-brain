// Cost-cap enforcement engine — Lane-3 v0.2 wave 2.
//
// Pure-TS module: per-dispatch -> per-session -> per-day concentric caps.
// checkCostCap() is the pure decision; recordSpend() drives the in-memory
// session/day totals; loadCostCapConfig() reads env. Used by voteRoutes
// for the pre-flight refusal gate and by the dashboard stat-tile.
//
// Naive token estimate = promptChars/4 + 500 output tokens (one safe
// default; users can override caps via env to compensate for over-runs).
//
// Daily reset: in-memory daily counter keyed on UTC date string. Crossing
// 00:00 UTC zeroes daySpentUsd for the affected session.

import type { TerminalAgentProvider } from "@octogent/core";

export type CostCapTier = "free" | "small-co";

export type CostCapConfig = {
  perDispatchUsd: number;
  perSessionUsd: number;
  perDayUsd: number;
  tier: CostCapTier;
};

export type CostEstimate = {
  provider: TerminalAgentProvider;
  estimatedTokens: number;
  estimatedUsd: number;
};

export type CostCapVerdict =
  | { ok: true; estimatedUsd: number }
  | {
      ok: false;
      reason:
        | "would-exceed-per-dispatch"
        | "would-exceed-per-session"
        | "would-exceed-per-day";
      remainingUsd: number;
      capUsd: number;
    };

// 2026-05 public per-1M-token prices. Updated quarterly — when a vendor
// drops a price tier, edit this table + bump @octogent/core minor.
//
// claude-code uses Sonnet 4 public list price ($3 in / $15 out).
// codex uses gpt-5-codex-mini (Cursor "Plus") at $0.25 in / $2 out.
// gemini-cli uses Gemini 2.5 Pro at $1.25 in / $10 out.
// aider runs against arbitrary local backends — default = $0 baseline.
export const DEFAULT_PROVIDER_RATES: Readonly<
  Record<TerminalAgentProvider, { inputUsdPer1MTok: number; outputUsdPer1MTok: number }>
> = Object.freeze({
  "claude-code": Object.freeze({ inputUsdPer1MTok: 3, outputUsdPer1MTok: 15 }),
  codex: Object.freeze({ inputUsdPer1MTok: 0.25, outputUsdPer1MTok: 2 }),
  "gemini-cli": Object.freeze({ inputUsdPer1MTok: 1.25, outputUsdPer1MTok: 10 }),
  aider: Object.freeze({ inputUsdPer1MTok: 0, outputUsdPer1MTok: 0 }),
});

const CHARS_PER_TOKEN = 4;
const OUTPUT_TOKEN_BUDGET = 500;

const DEFAULT_PER_DISPATCH = 0.5;
const DEFAULT_PER_SESSION = 5.0;
const DEFAULT_PER_DAY = 20.0;

const readPositiveFloat = (raw: string | undefined, fallback: number): number => {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
};

const readTier = (raw: string | undefined): CostCapTier => {
  return raw === "small-co" ? "small-co" : "free";
};

export const loadCostCapConfig = (): CostCapConfig => ({
  perDispatchUsd: readPositiveFloat(process.env.OCTOGENT_PER_DISPATCH_USD, DEFAULT_PER_DISPATCH),
  perSessionUsd: readPositiveFloat(process.env.OCTOGENT_PER_SESSION_USD, DEFAULT_PER_SESSION),
  perDayUsd: readPositiveFloat(process.env.OCTOGENT_PER_DAY_USD, DEFAULT_PER_DAY),
  tier: readTier(process.env.OCTOGENT_TIER),
});

export const estimateDispatchCost = (
  providers: ReadonlyArray<TerminalAgentProvider>,
  promptChars: number,
): CostEstimate[] => {
  const inputTokens = Math.ceil(Math.max(0, promptChars) / CHARS_PER_TOKEN);
  return providers.map((provider) => {
    const rate = DEFAULT_PROVIDER_RATES[provider];
    const inputCost = (inputTokens / 1_000_000) * rate.inputUsdPer1MTok;
    const outputCost = (OUTPUT_TOKEN_BUDGET / 1_000_000) * rate.outputUsdPer1MTok;
    return {
      provider,
      estimatedTokens: inputTokens + OUTPUT_TOKEN_BUDGET,
      estimatedUsd: inputCost + outputCost,
    };
  });
};

export const checkCostCap = (
  estimates: ReadonlyArray<CostEstimate>,
  usage: { sessionSpentUsd: number; daySpentUsd: number },
  config: CostCapConfig,
): CostCapVerdict => {
  const totalEstimateUsd = estimates.reduce((acc, e) => acc + e.estimatedUsd, 0);

  // Order matters: per-dispatch fires first because it isolates the
  // single bad call (mock UX text in the gif's punchline frame).
  if (totalEstimateUsd > config.perDispatchUsd) {
    return {
      ok: false,
      reason: "would-exceed-per-dispatch",
      remainingUsd: Math.max(0, config.perDispatchUsd),
      capUsd: config.perDispatchUsd,
    };
  }
  if (usage.sessionSpentUsd + totalEstimateUsd > config.perSessionUsd) {
    return {
      ok: false,
      reason: "would-exceed-per-session",
      remainingUsd: Math.max(0, config.perSessionUsd - usage.sessionSpentUsd),
      capUsd: config.perSessionUsd,
    };
  }
  if (usage.daySpentUsd + totalEstimateUsd > config.perDayUsd) {
    return {
      ok: false,
      reason: "would-exceed-per-day",
      remainingUsd: Math.max(0, config.perDayUsd - usage.daySpentUsd),
      capUsd: config.perDayUsd,
    };
  }
  return { ok: true, estimatedUsd: totalEstimateUsd };
};

// --- In-memory usage state ---------------------------------------------------
//
// Per-session totals are tracked in a Map keyed by sessionId. The daily
// counter resets when the UTC day flips (compared against dayStart).
//
// This deliberately mirrors the rateLimitBuckets pattern in security.ts:
// in-memory + test-reset hook, no DB writes on the request path.

type SessionUsage = {
  sessionSpentUsd: number;
  daySpentUsd: number;
  dayStart: number; // epoch ms of the start of the UTC day
};

const sessionUsage = new Map<string, SessionUsage>();

const utcDayStart = (now: number): number => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const recordSpend = (sessionId: string, usd: number, now: number = Date.now()): void => {
  if (!Number.isFinite(usd) || usd < 0) return;
  const today = utcDayStart(now);
  const existing = sessionUsage.get(sessionId);
  if (!existing || existing.dayStart !== today) {
    sessionUsage.set(sessionId, {
      sessionSpentUsd: (existing?.sessionSpentUsd ?? 0) + usd,
      daySpentUsd: usd, // daily reset
      dayStart: today,
    });
    return;
  }
  sessionUsage.set(sessionId, {
    sessionSpentUsd: existing.sessionSpentUsd + usd,
    daySpentUsd: existing.daySpentUsd + usd,
    dayStart: today,
  });
};

export const getSessionUsage = (
  sessionId: string,
  now: number = Date.now(),
): { sessionSpentUsd: number; daySpentUsd: number; dayStart: number } => {
  const today = utcDayStart(now);
  const existing = sessionUsage.get(sessionId);
  if (!existing) {
    return { sessionSpentUsd: 0, daySpentUsd: 0, dayStart: today };
  }
  // Lazy daily reset: if we cross UTC midnight, daySpent drops to 0 but
  // sessionSpent persists (the session may continue across the boundary).
  if (existing.dayStart !== today) {
    return {
      sessionSpentUsd: existing.sessionSpentUsd,
      daySpentUsd: 0,
      dayStart: today,
    };
  }
  return existing;
};

// Aggregate spend across all sessions for a given UTC day. The dashboard
// stat-tile reads this so users see a single dayBudget bar.
export const getDailySpend = (now: number = Date.now()): { daySpentUsd: number; dayStart: number } => {
  const today = utcDayStart(now);
  let total = 0;
  for (const entry of sessionUsage.values()) {
    if (entry.dayStart === today) {
      total += entry.daySpentUsd;
    }
  }
  return { daySpentUsd: total, dayStart: today };
};

export const resetCostCapState = (): void => {
  sessionUsage.clear();
};

// L3 audit r3 H4 (2026-05-12): audit-log payload redaction.
//
// The cost-cap audit JSONL is consumed by SIEM exporters and the Spend
// subtab. By default, the audit log should record WHAT happened
// (dispatch event, providers, cost, cap-fire reason) — NOT the content
// of the operator's prompt or rubric. Rubric prompts in particular can
// embed third-party secrets (a user pastes an API key into a verifier
// prompt; that key must not land in /tmp/octogent-audit.jsonl in plain
// text).
//
// Default behavior: any entry field named `taskInput`, `rubric`, or
// `prompt` is replaced with `<redacted N chars>` (so reviewers still
// see the size envelope, useful for sizing checks). Operators who need
// the full payload — e.g. for SOC2 evidence collection on an isolated
// host — opt in with OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD=1.
const REDACTABLE_AUDIT_FIELDS = ["taskInput", "rubric", "prompt"] as const;

export const auditPayloadIncluded = (): boolean =>
  process.env.OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD === "1";

export const redactAuditEntry = <T extends Record<string, unknown>>(entry: T): T => {
  if (auditPayloadIncluded()) {
    return entry;
  }
  const out: Record<string, unknown> = { ...entry };
  for (const field of REDACTABLE_AUDIT_FIELDS) {
    if (field in out && out[field] !== undefined && out[field] !== null) {
      const raw = out[field];
      let length = 0;
      if (typeof raw === "string") {
        length = raw.length;
      } else {
        try {
          length = JSON.stringify(raw).length;
        } catch {
          length = 0;
        }
      }
      out[field] = `<redacted ${length} chars>`;
    }
  }
  return out as T;
};
