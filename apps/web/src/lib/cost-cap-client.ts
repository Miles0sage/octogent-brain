// Lane-3 cost-cap UX wave 2 — frontend client.
//
// Duplicates the minimal shape of @octogent/api's cost-cap module here
// rather than adding a workspace dep on apps/api (per the spec). The
// types are tiny + structural so drift is checkable by eye.

export type CostCapTier = "free" | "small-co";

export type CostCapConfigClient = {
  perDispatchUsd: number;
  perSessionUsd: number;
  perDayUsd: number;
  tier: CostCapTier;
};

export type CostCapStatus = {
  config: CostCapConfigClient;
  usage: {
    daySpentUsd: number;
    dayStart: number;
  };
};

export type CostCapAuditEntry = {
  ts: string;
  event: "vote-dispatched" | "cap-fire" | "voter-completed";
  sessionId: string;
  providers?: ReadonlyArray<string>;
  estimatedUsd?: number;
  capUsd?: number;
  reason?: string;
  provider?: string;
  actualUsd?: number;
};

const isCostCapStatus = (v: unknown): v is CostCapStatus => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.config !== "object" || o.config === null) return false;
  const c = o.config as Record<string, unknown>;
  if (typeof c.perDayUsd !== "number") return false;
  if (typeof c.perSessionUsd !== "number") return false;
  if (typeof c.perDispatchUsd !== "number") return false;
  if (typeof o.usage !== "object" || o.usage === null) return false;
  const u = o.usage as Record<string, unknown>;
  if (typeof u.daySpentUsd !== "number") return false;
  return true;
};

// Returns null on 404 — the API answers 404 for tier=free w/ no cap
// configured, and the UI must collapse gracefully (no error, no tile).
// Also returns null when the body fails shape validation (e.g. a
// mid-test fetch stub that serves a different JSON to every URL).
export const fetchCostCapStatus = async (): Promise<CostCapStatus | null> => {
  const r = await fetch("/api/claude-brain/cost-cap");
  if (r.status === 404) return null;
  if (!r.ok) {
    throw new Error(`cost-cap status fetch failed: HTTP ${r.status}`);
  }
  const body = (await r.json()) as unknown;
  if (!isCostCapStatus(body)) return null;
  return body;
};

export const fetchCostCapAudit = async (): Promise<ReadonlyArray<CostCapAuditEntry>> => {
  const r = await fetch("/api/claude-brain/cost-cap/audit");
  if (!r.ok) {
    throw new Error(`cost-cap audit fetch failed: HTTP ${r.status}`);
  }
  const body = (await r.json()) as { entries: CostCapAuditEntry[] };
  return body.entries;
};

export const formatUsd = (n: number): string => {
  return `$${n.toFixed(2)}`;
};

// "Resets in 5h 23m (00:00 UTC)" — used by CostCapTile tooltip + Spend
// subtab footer. Pure: takes a now-ms + dayStart-ms and returns the
// human label.
export const formatResetIn = (nowMs: number, dayStartMs: number): string => {
  const nextDay = dayStartMs + 24 * 60 * 60 * 1000;
  const msLeft = Math.max(0, nextDay - nowMs);
  const hours = Math.floor(msLeft / (60 * 60 * 1000));
  const minutes = Math.floor((msLeft % (60 * 60 * 1000)) / (60 * 1000));
  return `Resets in ${hours}h ${minutes}m (00:00 UTC)`;
};
