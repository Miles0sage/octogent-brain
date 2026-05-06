import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { ApiRouteHandler } from "./routeHelpers";
import { writeJson, writeMethodNotAllowed } from "./routeHelpers";

// Read-only SQLite query layer for the AgentLightning-lite store.
// The Python side (BriefingDeck) is the writer; we shell out to the
// `sqlite3` CLI in JSON mode rather than depending on a Node native
// SQLite binding. That keeps Octogent's bundle pure JS and matches the
// `spawnSync(systemctl, ...)` pattern already used in claudeBrainRoutes.
//
// Path resolution mirrors the Python convention: BRIEFINGDECK_DB_PATH ->
// BRIEFINGDECK_DB -> /root/briefingdeck/briefingdeck.db.

const SQLITE_TIMEOUT_MS = 2000;

const resolveDbPath = (): string =>
  process.env.BRIEFINGDECK_DB_PATH?.trim() ||
  process.env.BRIEFINGDECK_DB?.trim() ||
  "/root/briefingdeck/briefingdeck.db";

type QueryResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; error: string };

const querySqlite = <T = Record<string, unknown>>(
  dbPath: string,
  sql: string,
): QueryResult<T> => {
  if (!existsSync(dbPath)) {
    return { ok: false, error: `db not found: ${dbPath}` };
  }
  const result = spawnSync("sqlite3", ["-readonly", "-json", dbPath, sql], {
    encoding: "utf8",
    timeout: SQLITE_TIMEOUT_MS,
  });
  if (result.error) {
    return { ok: false, error: result.error.message };
  }
  if (result.status !== 0) {
    return { ok: false, error: (result.stderr ?? "").trim() || "sqlite3 failed" };
  }
  const stdout = (result.stdout ?? "").trim();
  if (!stdout) {
    return { ok: true, rows: [] };
  }
  try {
    const parsed = JSON.parse(stdout) as T[];
    return { ok: true, rows: Array.isArray(parsed) ? parsed : [] };
  } catch (error) {
    return {
      ok: false,
      error: `failed to parse sqlite3 output: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};

// `sqlite3 -json` does not bind parameters; we manually escape integers
// and strings used in WHERE clauses. Values are always coerced to safe
// types — never raw user input — so the surface for injection is small.
const escapeSqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;
const escapeSqlInt = (value: number): string => String(Math.floor(value));

const safeNumber = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const safeString = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return String(value);
};

const isoFromEpochSeconds = (epoch: unknown): string | null => {
  const n = safeNumber(epoch);
  if (!n) return null;
  return new Date(n * 1000).toISOString();
};

type RolloutSummary = {
  rollout_id: string;
  agent_name: string;
  status: string;
  reward_total: number;
  started_at_iso: string | null;
  finished_at_iso: string | null;
  latency_ms: number | null;
};

const rowToSummary = (row: Record<string, unknown>): RolloutSummary => {
  const startedAt = safeNumber(row.started_at);
  const finishedAt =
    row.finished_at === null || row.finished_at === undefined
      ? null
      : safeNumber(row.finished_at);
  return {
    rollout_id: safeString(row.rollout_id),
    agent_name: safeString(row.agent_name),
    status: safeString(row.status),
    reward_total: safeNumber(row.reward_total),
    started_at_iso: isoFromEpochSeconds(startedAt),
    finished_at_iso: finishedAt !== null ? isoFromEpochSeconds(finishedAt) : null,
    latency_ms:
      finishedAt !== null && startedAt
        ? Math.max(0, Math.round((finishedAt - startedAt) * 1000))
        : null,
  };
};

// --- GET /api/claude-brain/rollouts -------------------------------------

export const handleClaudeBrainRolloutsRoute: ApiRouteHandler = async ({
  request,
  response,
  requestUrl,
  corsOrigin,
}) => {
  if (requestUrl.pathname !== "/api/claude-brain/rollouts") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const limitParam = requestUrl.searchParams.get("limit");
  const parsedLimit = limitParam ? Number.parseInt(limitParam, 10) : 20;
  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 20;
  const dbPath = resolveDbPath();

  const sql =
    "SELECT rollout_id, agent_name, status, reward_total, started_at, finished_at " +
    `FROM rollouts ORDER BY started_at DESC, rollout_id DESC LIMIT ${escapeSqlInt(limit)}`;
  const result = querySqlite(dbPath, sql);
  if (!result.ok) {
    writeJson(
      response,
      200,
      {
        rollouts: [],
        db_path: dbPath,
        limit,
        note: `BriefingDeck rollouts unavailable: ${result.error}`,
      },
      corsOrigin,
    );
    return true;
  }

  const rollouts = result.rows.map(rowToSummary);
  writeJson(response, 200, { rollouts, db_path: dbPath, limit }, corsOrigin);
  return true;
};

// --- GET /api/claude-brain/rollouts/:id ----------------------------------

export const handleClaudeBrainRolloutItemRoute: ApiRouteHandler = async ({
  request,
  response,
  requestUrl,
  corsOrigin,
}) => {
  const match = requestUrl.pathname.match(/^\/api\/claude-brain\/rollouts\/([^/]+)$/);
  if (!match) {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const rolloutId = decodeURIComponent(match[1] ?? "");
  if (!rolloutId) {
    writeJson(response, 400, { error: "missing rollout_id" }, corsOrigin);
    return true;
  }
  // Whitelist the rollout_id surface — uuid hex / ADK invocation_id-like
  // strings only. Keeps the inline-SQL escape narrow.
  if (!/^[A-Za-z0-9._:\-]{1,128}$/.test(rolloutId)) {
    writeJson(response, 400, { error: "invalid rollout_id" }, corsOrigin);
    return true;
  }

  const dbPath = resolveDbPath();
  const idLit = escapeSqlString(rolloutId);

  const rolloutResult = querySqlite(
    dbPath,
    "SELECT rollout_id, agent_name, status, reward_total, started_at, finished_at " +
      `FROM rollouts WHERE rollout_id = ${idLit}`,
  );
  if (!rolloutResult.ok) {
    writeJson(
      response,
      404,
      {
        error: "rollout store not available",
        db_path: dbPath,
        detail: rolloutResult.error,
      },
      corsOrigin,
    );
    return true;
  }
  const rolloutRow = rolloutResult.rows[0];
  if (!rolloutRow) {
    writeJson(
      response,
      404,
      { error: "rollout not found", rollout_id: rolloutId },
      corsOrigin,
    );
    return true;
  }

  const spansResult = querySqlite(
    dbPath,
    "SELECT span_id, parent_span_id, name, attributes, started_at, finished_at " +
      `FROM spans WHERE rollout_id = ${idLit} ORDER BY started_at ASC`,
  );
  const tripletsResult = querySqlite(
    dbPath,
    "SELECT id, prompt, response, reward, metadata, created_at " +
      `FROM triplets WHERE rollout_id = ${idLit} ORDER BY created_at ASC`,
  );

  const spans = (spansResult.ok ? spansResult.rows : []).map((s) => ({
    span_id: safeString(s.span_id),
    parent_span_id: s.parent_span_id ? safeString(s.parent_span_id) : null,
    name: safeString(s.name),
    attributes: safeString(s.attributes),
    started_at_iso: isoFromEpochSeconds(s.started_at),
    finished_at_iso:
      s.finished_at === null || s.finished_at === undefined
        ? null
        : isoFromEpochSeconds(s.finished_at),
  }));
  const triplets = (tripletsResult.ok ? tripletsResult.rows : []).map((t) => ({
    id: safeString(t.id),
    prompt: safeString(t.prompt),
    response: safeString(t.response),
    reward: safeNumber(t.reward),
    metadata: safeString(t.metadata),
    created_at_iso: isoFromEpochSeconds(t.created_at),
  }));

  writeJson(
    response,
    200,
    { rollout: rowToSummary(rolloutRow), spans, triplets },
    corsOrigin,
  );
  return true;
};

// --- GET /api/claude-brain/rewards/recent --------------------------------

export const handleClaudeBrainRewardsRecentRoute: ApiRouteHandler = async ({
  request,
  response,
  requestUrl,
  corsOrigin,
}) => {
  if (requestUrl.pathname !== "/api/claude-brain/rewards/recent") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const daysParam = requestUrl.searchParams.get("days");
  const parsedDays = daysParam ? Number.parseInt(daysParam, 10) : 7;
  const days = Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : 7;
  const cutoffEpochSeconds = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const dbPath = resolveDbPath();

  const sql =
    "SELECT t.id, t.rollout_id, t.reward, t.created_at, r.agent_name " +
    "FROM triplets t LEFT JOIN rollouts r ON r.rollout_id = t.rollout_id " +
    `WHERE t.created_at >= ${escapeSqlInt(cutoffEpochSeconds)} ` +
    "ORDER BY t.created_at DESC LIMIT 1000";
  const result = querySqlite(dbPath, sql);
  if (!result.ok) {
    writeJson(
      response,
      200,
      {
        days,
        rewards: [],
        by_agent: {},
        note: `BriefingDeck rewards unavailable: ${result.error}`,
      },
      corsOrigin,
    );
    return true;
  }

  const rewards = result.rows.map((row) => ({
    id: safeString(row.id),
    rollout_id: safeString(row.rollout_id),
    agent_name: safeString(row.agent_name),
    reward: safeNumber(row.reward),
    created_at_iso: isoFromEpochSeconds(row.created_at),
  }));

  const byAgent: Record<
    string,
    { count: number; total_reward: number; mean_reward: number }
  > = {};
  for (const r of rewards) {
    const key = r.agent_name || "<unknown>";
    const bucket = byAgent[key] ?? { count: 0, total_reward: 0, mean_reward: 0 };
    bucket.count += 1;
    bucket.total_reward += r.reward;
    byAgent[key] = bucket;
  }
  for (const key of Object.keys(byAgent)) {
    const bucket = byAgent[key];
    if (bucket && bucket.count > 0) {
      bucket.mean_reward = Number((bucket.total_reward / bucket.count).toFixed(4));
      bucket.total_reward = Number(bucket.total_reward.toFixed(4));
    }
  }

  writeJson(response, 200, { days, rewards, by_agent: byAgent }, corsOrigin);
  return true;
};
