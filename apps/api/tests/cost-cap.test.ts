// Lane-3 cost-cap UX wave 2 — pure-TS enforcement engine.
//
// 3 concentric budgets: per-dispatch -> per-session -> per-day. The first
// cap to trip wins. checkCostCap() is the pure decision; recordSpend()
// drives the in-memory session/day totals; loadCostCapConfig() reads env.
//
// All tests reset state via resetCostCapState() so they stay independent.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PROVIDER_RATES,
  checkCostCap,
  estimateDispatchCost,
  loadCostCapConfig,
  recordSpend,
  resetCostCapState,
  type CostCapConfig,
} from "../src/cost-cap";

const baseConfig = (overrides: Partial<CostCapConfig> = {}): CostCapConfig => ({
  perDispatchUsd: 0.5,
  perSessionUsd: 5.0,
  perDayUsd: 20.0,
  tier: "free",
  ...overrides,
});

describe("cost-cap — DEFAULT_PROVIDER_RATES", () => {
  it("contains real public 2026-05 prices for every TerminalAgentProvider", () => {
    // Spec contract: claude-sonnet-4 $3/$15, gpt-5-codex-mini $0.25/$2,
    // gemini-2.5-pro $1.25/$10, aider local $0. Test asserts non-zero
    // for paid providers + presence of all known providers.
    expect(DEFAULT_PROVIDER_RATES["claude-code"]).toBeDefined();
    expect(DEFAULT_PROVIDER_RATES["claude-code"].inputUsdPer1MTok).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDER_RATES["claude-code"].outputUsdPer1MTok).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDER_RATES["codex"]).toBeDefined();
    expect(DEFAULT_PROVIDER_RATES["codex"].inputUsdPer1MTok).toBeGreaterThan(0);
    expect(DEFAULT_PROVIDER_RATES["gemini-cli"]).toBeDefined();
    expect(DEFAULT_PROVIDER_RATES["gemini-cli"].inputUsdPer1MTok).toBeGreaterThan(0);
    // aider runs against arbitrary local backends; default = $0 baseline.
    expect(DEFAULT_PROVIDER_RATES["aider"]).toBeDefined();
    expect(DEFAULT_PROVIDER_RATES["aider"].inputUsdPer1MTok).toBe(0);
    expect(DEFAULT_PROVIDER_RATES["aider"].outputUsdPer1MTok).toBe(0);
  });
});

describe("cost-cap — estimateDispatchCost", () => {
  it("returns one CostEstimate per provider", () => {
    const estimates = estimateDispatchCost(["claude-code", "codex"], 1000);
    expect(estimates).toHaveLength(2);
    expect(estimates[0]?.provider).toBe("claude-code");
    expect(estimates[1]?.provider).toBe("codex");
  });

  it("is monotonic in promptChars (longer prompt = more expensive)", () => {
    const small = estimateDispatchCost(["claude-code"], 100);
    const big = estimateDispatchCost(["claude-code"], 10_000);
    expect(big[0]?.estimatedUsd).toBeGreaterThan(small[0]?.estimatedUsd ?? 0);
    expect(big[0]?.estimatedTokens).toBeGreaterThan(small[0]?.estimatedTokens ?? 0);
  });

  it("returns $0 for aider (local backend)", () => {
    const estimates = estimateDispatchCost(["aider"], 10_000);
    expect(estimates[0]?.estimatedUsd).toBe(0);
  });

  it("returns higher USD for claude-code than gemini-cli at same prompt size", () => {
    // claude-sonnet-4 is more expensive than gemini-2.5-pro.
    const [claude] = estimateDispatchCost(["claude-code"], 5000);
    const [gem] = estimateDispatchCost(["gemini-cli"], 5000);
    expect(claude?.estimatedUsd ?? 0).toBeGreaterThan(gem?.estimatedUsd ?? 0);
  });
});

describe("cost-cap — checkCostCap", () => {
  it("ok=true when sum of estimates is under all three caps", () => {
    const estimates = estimateDispatchCost(["aider"], 100); // $0 cost
    const verdict = checkCostCap(
      estimates,
      { sessionSpentUsd: 0, daySpentUsd: 0 },
      baseConfig(),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.estimatedUsd).toBe(0);
    }
  });

  it("trips per-dispatch when single dispatch sum exceeds perDispatchUsd", () => {
    const estimates = estimateDispatchCost(["claude-code"], 10_000_000); // huge
    const verdict = checkCostCap(
      estimates,
      { sessionSpentUsd: 0, daySpentUsd: 0 },
      baseConfig({ perDispatchUsd: 0.01 }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("would-exceed-per-dispatch");
      expect(verdict.capUsd).toBe(0.01);
      expect(verdict.remainingUsd).toBeLessThanOrEqual(0.01);
    }
  });

  it("trips per-session when sessionSpent + estimate exceeds perSessionUsd", () => {
    // 1000 chars -> ~$0.008 for claude-code; with sessionSpent=4.999 and
    // perSession=5.00, the sum (~5.007) crosses the cap.
    const estimates = estimateDispatchCost(["claude-code"], 1000);
    const verdict = checkCostCap(
      estimates,
      { sessionSpentUsd: 4.999, daySpentUsd: 4.999 },
      baseConfig({ perDispatchUsd: 10, perSessionUsd: 5, perDayUsd: 20 }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("would-exceed-per-session");
      expect(verdict.capUsd).toBe(5);
    }
  });

  it("trips per-day when daySpent + estimate exceeds perDayUsd", () => {
    const estimates = estimateDispatchCost(["claude-code"], 1000);
    const verdict = checkCostCap(
      estimates,
      { sessionSpentUsd: 0, daySpentUsd: 19.999 },
      baseConfig({ perDispatchUsd: 10, perSessionUsd: 100, perDayUsd: 20 }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("would-exceed-per-day");
      expect(verdict.capUsd).toBe(20);
    }
  });

  it("returns per-dispatch reason first when multiple caps would trip", () => {
    // Sufficient prompt size that single dispatch exceeds the tiny per-dispatch cap.
    const estimates = estimateDispatchCost(["claude-code"], 10_000_000);
    const verdict = checkCostCap(
      estimates,
      { sessionSpentUsd: 100, daySpentUsd: 100 },
      baseConfig({ perDispatchUsd: 0.01, perSessionUsd: 1, perDayUsd: 1 }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("would-exceed-per-dispatch");
    }
  });
});

describe("cost-cap — loadCostCapConfig", () => {
  let prevDispatch: string | undefined;
  let prevSession: string | undefined;
  let prevDay: string | undefined;
  let prevTier: string | undefined;

  beforeEach(() => {
    prevDispatch = process.env.OCTOGENT_PER_DISPATCH_USD;
    prevSession = process.env.OCTOGENT_PER_SESSION_USD;
    prevDay = process.env.OCTOGENT_PER_DAY_USD;
    prevTier = process.env.OCTOGENT_TIER;
    delete process.env.OCTOGENT_PER_DISPATCH_USD;
    delete process.env.OCTOGENT_PER_SESSION_USD;
    delete process.env.OCTOGENT_PER_DAY_USD;
    delete process.env.OCTOGENT_TIER;
  });
  afterEach(() => {
    if (prevDispatch === undefined) delete process.env.OCTOGENT_PER_DISPATCH_USD;
    else process.env.OCTOGENT_PER_DISPATCH_USD = prevDispatch;
    if (prevSession === undefined) delete process.env.OCTOGENT_PER_SESSION_USD;
    else process.env.OCTOGENT_PER_SESSION_USD = prevSession;
    if (prevDay === undefined) delete process.env.OCTOGENT_PER_DAY_USD;
    else process.env.OCTOGENT_PER_DAY_USD = prevDay;
    if (prevTier === undefined) delete process.env.OCTOGENT_TIER;
    else process.env.OCTOGENT_TIER = prevTier;
  });

  it("uses defaults (0.50 / 5.00 / 20.00, free tier) when env unset", () => {
    const config = loadCostCapConfig();
    expect(config.perDispatchUsd).toBe(0.5);
    expect(config.perSessionUsd).toBe(5.0);
    expect(config.perDayUsd).toBe(20.0);
    expect(config.tier).toBe("free");
  });

  it("reads OCTOGENT_PER_DISPATCH_USD / PER_SESSION_USD / PER_DAY_USD env overrides", () => {
    process.env.OCTOGENT_PER_DISPATCH_USD = "1.25";
    process.env.OCTOGENT_PER_SESSION_USD = "12.50";
    process.env.OCTOGENT_PER_DAY_USD = "100";
    const config = loadCostCapConfig();
    expect(config.perDispatchUsd).toBe(1.25);
    expect(config.perSessionUsd).toBe(12.5);
    expect(config.perDayUsd).toBe(100);
  });

  it("reads OCTOGENT_TIER=small-co", () => {
    process.env.OCTOGENT_TIER = "small-co";
    const config = loadCostCapConfig();
    expect(config.tier).toBe("small-co");
  });

  it("ignores invalid (non-numeric) env values and falls back to defaults", () => {
    process.env.OCTOGENT_PER_DISPATCH_USD = "not-a-number";
    const config = loadCostCapConfig();
    expect(config.perDispatchUsd).toBe(0.5);
  });
});

describe("cost-cap — in-memory spend state + daily reset", () => {
  beforeEach(() => {
    resetCostCapState();
  });
  afterEach(() => {
    resetCostCapState();
  });

  it("recordSpend accumulates per-session totals (visible via getSessionUsage)", async () => {
    const { getSessionUsage } = await import("../src/cost-cap");
    recordSpend("session-A", 0.25);
    recordSpend("session-A", 0.5);
    const usage = getSessionUsage("session-A");
    expect(usage.sessionSpentUsd).toBeCloseTo(0.75, 6);
    expect(usage.daySpentUsd).toBeCloseTo(0.75, 6);
  });

  it("recordSpend resets daySpent across UTC midnight while keeping sessionSpent", async () => {
    const { getSessionUsage } = await import("../src/cost-cap");
    // Day 1: $2 spent.
    const dayOne = Date.UTC(2026, 4, 12, 23, 30, 0); // 2026-05-12 23:30Z
    recordSpend("session-A", 2.0, dayOne);
    // Day 2: $1 spent (midnight crossed).
    const dayTwo = Date.UTC(2026, 4, 13, 0, 30, 0);
    recordSpend("session-A", 1.0, dayTwo);
    const usage = getSessionUsage("session-A", dayTwo);
    expect(usage.sessionSpentUsd).toBeCloseTo(3.0, 6);
    expect(usage.daySpentUsd).toBeCloseTo(1.0, 6);
  });

  it("resetCostCapState clears all in-memory totals", async () => {
    const { getSessionUsage } = await import("../src/cost-cap");
    recordSpend("session-A", 4.99);
    resetCostCapState();
    const usage = getSessionUsage("session-A");
    expect(usage.sessionSpentUsd).toBe(0);
    expect(usage.daySpentUsd).toBe(0);
  });
});

