# Cost-cap enforcement — design spec (v0.2 of @octogent/supervisor)

Decided 2026-05-12 after brainstorming Q1; user delegated the design choice ("you know the answer, make a good decision"). Following questions deferred to implementation — covered by sensible defaults below.

## Problem

Today `maxCostUsd` is a documented but never-enforced field. The L3 audit caught it as a false-confidence guardrail (we removed it as M1 in commit `2b97cdb`). L2 monetization research listed cost-cap controls as the $200/mo small-co tier differentiator: "won't drain your credits." We need to actually ship the guardrail this time.

## Decision

**Layered cap: per-dispatch → per-session → per-day. Any layer exceeded = SIGTERM child + emit event. Token-count is the primary unit; $-USD is derived from a per-provider rate table.**

Three concentric budgets. The narrow per-dispatch limit catches one bad call; the per-session limit catches a runaway verdict loop; the per-day limit catches a runaway process. Each layer is independently configurable.

## Why layered, not single-window

NBLM-L2 mapped pricing tiers to features. Layered scales cleanly:

| Tier | Layers active | Defaults |
|---|---|---|
| OSS (free) | per-dispatch only | 50k input + 20k output tokens / dispatch |
| Solo $5/mo | + per-session | 250k input + 100k output / session |
| Team $25/mo | + per-day | $20/day soft cap |
| Small-Co $200/mo | + audit log | SIEM-exportable spend ledger |
| Enterprise $2k/mo | + multi-tenant | per-team budget API |

A single-window cap can't represent this without ugly tier-leakage.

## Schema additions (`@octogent/core`)

```ts
export type CostBudget = {
  maxInputTokens?: number;       // hard cap; -1 disables
  maxOutputTokens?: number;
  maxUsd?: number;               // derived from per-provider rate table
};

export type CostCapConfig = {
  perDispatch?: CostBudget;
  perSession?: CostBudget;
  perDay?: CostBudget;
};

// Added to DriverSpec — per-driver overrides the routing-config-level
// caps. Most users will set caps on the rule, not the driver.
export type DriverSpec = {
  // ... existing fields
  costCap?: CostCapConfig;
};

// Added to RoutingConfig:
export type RoutingConfig = {
  // ... existing fields
  costCap?: CostCapConfig;
};

// Per-provider $/Mtok rates for $-USD derivation. Updated quarterly
// in source; users can override in routing.json.
export const DEFAULT_PROVIDER_RATES: Readonly<Record<TerminalAgentProvider, {
  inputPerMTok: number;
  outputPerMTok: number;
}>> = Object.freeze({
  "claude-code": { inputPerMTok: 3, outputPerMTok: 15 },   // Sonnet 4.6
  "aider": { inputPerMTok: 0.50, outputPerMTok: 1.50 },     // GPT-4o-mini default
  "codex": { inputPerMTok: 0.50, outputPerMTok: 1.50 },
  "gemini-cli": { inputPerMTok: 0.30, outputPerMTok: 2.50 }, // Gemini 2.5 Flash
});
```

## Enforcement points

| Layer | Trigger | Action |
|---|---|---|
| per-dispatch | Each `dispatchTask` call counts stdout chunks. Token estimate = bytes/4 (conservative; UTF-8 worst-case). | Hits cap → SIGTERM the child, append `{kind: "cost-cap-exceeded", layer: "dispatch"}` event, return DispatchResult with `health: {healthy: false, reason: "cost-cap"}`. |
| per-session | Verdict-watcher attaches a counter that sums across iterations. Each iteration's dispatch contributes. | Cap hit → watcher emits `{kind: "loop-terminated", reason: "cost-cap"}`. Distinct from "max" (iter cap) or "fp" (false-positive cap). |
| per-day | In-memory daily counter on the supervisor process, keyed by date in UTC, reset on date change. | Cap hit → all subsequent `dispatchTask` calls refuse to spawn until next UTC date. Returns `health: {healthy: false, reason: "daily-budget-exceeded"}`. |

## Telemetry

Every cap event emits to:
- `console.warn` w/ structured JSON
- The terminal WebSocket if a session is attached
- An optional `events.jsonl` audit log if `OCTOGENT_AUDIT_LOG=<path>` is set

## Dashboard surface (RolloutsGantt addendum, future)

- Stat tile: today's USD spend + daily cap as a progress bar
- Bar color on Gantt: bars darken near per-dispatch cap, red if SIGTERM'd
- Vote demo card: show estimated cost per voter before dispatch, refuse if any voter would exceed per-day cap

## Test plan

- Pure-TS unit tests for CostBudget computation + percentage-of-cap arithmetic
- Watcher test asserting `loop-terminated` w/ `reason: "cost-cap"`
- Dispatcher test asserting SIGTERM at per-dispatch cap (mock long-stdout subprocess)
- Daily-counter test asserting reset across UTC midnight (mock Date.now)
- API route test for `health: {reason: "cost-cap"}` shape

## Non-goals

- No live $-rate lookup from provider APIs (uses the static rate table; users update routing.json if rates change)
- No retroactive billing reconciliation (we track our estimates, not the actual billed amount)
- No multi-tenant budget API in v0.2 (enterprise tier work)
- No prompt-cache discounting math (would require parsing the response shape per provider; deferred)

## Implementation order

1. Schema additions in `@octogent/core` (CostBudget, CostCapConfig, DriverSpec.costCap, RoutingConfig.costCap, DEFAULT_PROVIDER_RATES)
2. Per-dispatch enforcement in `@octogent/supervisor/src/dispatcher.ts` (token estimate + SIGTERM)
3. Per-session enforcement in `@octogent/supervisor/src/watcher.ts` (cumulative counter + new loop-terminated reason)
4. Per-day enforcement in a new `@octogent/supervisor/src/budget.ts` module (in-memory daily map)
5. Wire all three into `voteRoutes.ts` so vote.dispatch sees pre-flight `daily-budget-exceeded` before fan-out
6. Tests for each layer
7. Add cost-stat tile + Gantt color cue (apps/web, future patch)

Estimated effort: 4-6 hours focused. Larger than the M-fixes pass (~2h) because this introduces new public schema in `@octogent/core` that other consumers will lock onto.
