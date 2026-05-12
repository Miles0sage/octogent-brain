import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as resolvePath, sep } from "node:path";

import {
  type RoutingConfig,
  type TerminalAgentProvider,
} from "@octogent/core";
import {
  checkProviderHealth,
  dispatchTask,
  loadRoutingConfig,
} from "@octogent/supervisor";
import type { ApiRouteHandler } from "./routeHelpers";
import {
  readJsonBodyOrWriteError,
  writeJson,
  writeMethodNotAllowed,
} from "./routeHelpers";
import { checkAuthorizedRequest } from "./security";

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// L3 audit M3 (2026-05-12): cwd allowlist for driver/vote dispatch.
//
// Without this gate, a client could ask the API to spawn an agent
// subprocess with cwd=/etc, /root/.ssh, or any directory the API user
// can read. The agent then exfiltrates files via its read-tool output.
//
// Allowlist: the configured workspace root plus any path under
// ~/.octogent/tentacles/<id>/worktree (the sanctioned per-tentacle
// workspaces). path.resolve canonicalizes ".." before the prefix check
// so `~/.octogent/tentacles/x/worktree/../../..` correctly resolves
// outside the allowlist and is rejected.
//
// Exported so voteRoutes.ts can apply the identical policy.
export const TENTACLES_ROOT = resolvePath(homedir(), ".octogent", "tentacles");

const canonicalizeExistingPath = (candidate: string): string | null => {
  try {
    return realpathSync.native(candidate);
  } catch {
    return null;
  }
};

export const isCwdAllowed = (candidate: string, workspaceCwd: string): boolean => {
  const resolved = canonicalizeExistingPath(candidate);
  const workspace = canonicalizeExistingPath(workspaceCwd);
  if (resolved === null || workspace === null) {
    return false;
  }
  if (resolved === workspace) return true;
  if (resolved.startsWith(workspace + sep)) {
    return true;
  }
  // Must be under ~/.octogent/tentacles/<id>/worktree (or deeper).
  // We accept any prefix of the form TENTACLES_ROOT/<id>/worktree.
  const tentaclesRoot = canonicalizeExistingPath(TENTACLES_ROOT);
  if (tentaclesRoot === null) {
    return false;
  }
  const prefix = tentaclesRoot + sep;
  if (!resolved.startsWith(prefix) && resolved !== tentaclesRoot) {
    return false;
  }
  // resolved is /home/.../.octogent/tentacles/<rest>. Split off <id>
  // and require the next segment to be "worktree".
  const tail = resolved.slice(prefix.length); // <id>/worktree/...
  const segments = tail.split(sep);
  if (segments.length < 2) return false;
  if (segments[1] !== "worktree") return false;
  return true;
};

// GET /api/claude-brain/drivers — list configured drivers + their live
// health probe results. Used by the "Drivers" dashboard panel.
//
// Codex audit 2026-05-12: gate behind bearer/loopback auth. Health probes
// spawn subprocesses (resource cost) and the provider list is a recon
// signal (which CLIs the host can reach). Gating the whole GET matches
// the rate-limited POST contract already in place for /drivers/dispatch.
export const handleDriversListRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/drivers") {
    return false;
  }
  if (request.method !== "GET") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  const auth = checkAuthorizedRequest(request);
  if (!auth.ok) {
    writeJson(response, auth.status, { error: auth.reason }, corsOrigin);
    return true;
  }

  const loaded = loadRoutingConfig();
  if (!loaded.ok) {
    writeJson(response, 200, { config: null, error: loaded }, corsOrigin);
    return true;
  }
  const config: RoutingConfig = loaded.config;

  const drivers = await Promise.all(
    config.drivers.map(async (driver) => ({
      provider: driver.provider,
      transport: driver.transport,
      capabilities: driver.capabilities,
      command: driver.command,
      requiredEnv: driver.requiredEnv,
      // maxCostUsd removed per L3 audit M1 (2026-05-12).
      health: await checkProviderHealth(driver.provider, config),
    })),
  );

  writeJson(
    response,
    200,
    {
      config_source: loaded.source,
      defaultProvider: config.defaultProvider,
      drivers,
      rules: config.rules,
    },
    corsOrigin,
  );
  return true;
};

// POST /api/claude-brain/drivers/dispatch — run a task through the
// dispatcher. Body: { taskType: string, taskInput: string, cwd?: string,
// dryRun?: boolean }. The dispatcher picks the driver, checks health,
// spawns via stdio, and returns a DriverDispatchResult.
export const handleDriversDispatchRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  if (requestUrl.pathname !== "/api/claude-brain/drivers/dispatch") {
    return false;
  }
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  // L3 audit r2 C1 (2026-05-12): bearer-token / loopback gate + per-IP
  // rate limit. /drivers/dispatch spawns subprocesses; identical gate
  // to /votes/dispatch.
  const auth = checkAuthorizedRequest(request);
  if (!auth.ok) {
    writeJson(response, auth.status, { error: auth.reason }, corsOrigin);
    return true;
  }

  const bodyResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyResult.ok) return true;

  const body = bodyResult.payload;
  if (typeof body !== "object" || body === null) {
    writeJson(response, 400, { error: "body must be a JSON object" }, corsOrigin);
    return true;
  }
  const fields = body as Record<string, unknown>;
  if (!isString(fields.taskType)) {
    writeJson(response, 400, { error: "taskType is required" }, corsOrigin);
    return true;
  }
  if (!isString(fields.taskInput)) {
    writeJson(response, 400, { error: "taskInput is required" }, corsOrigin);
    return true;
  }
  const cwd =
    typeof fields.cwd === "string" && fields.cwd.length > 0
      ? fields.cwd
      : workspaceCwd;
  // L3 audit M3 (2026-05-12): refuse cwds outside the workspace + the
  // sanctioned tentacle worktrees. See isCwdAllowed above.
  if (!isCwdAllowed(cwd, workspaceCwd)) {
    writeJson(
      response,
      400,
      { error: "cwd not within allowed workspace" },
      corsOrigin,
    );
    return true;
  }
  const dryRun = fields.dryRun === true;

  const loaded = loadRoutingConfig();
  if (!loaded.ok) {
    writeJson(response, 500, { error: "routing config invalid", detail: loaded }, corsOrigin);
    return true;
  }

  const result = await dispatchTask(loaded.config, {
    taskType: fields.taskType,
    taskInput: fields.taskInput,
    cwd,
    dryRun,
  });

  writeJson(response, 200, result, corsOrigin);
  return true;
};

// Suppress unused-import lint until the routes use the provider type for
// future health summaries.
type _ProviderRef = TerminalAgentProvider;
void ({} as _ProviderRef);
