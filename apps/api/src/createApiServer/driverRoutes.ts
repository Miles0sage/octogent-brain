import {
  type RoutingConfig,
  type TerminalAgentProvider,
} from "@octogent/core";

import { checkProviderHealth, dispatchTask } from "../drivers/dispatcher";
import { loadRoutingConfig } from "../drivers/routingLoader";
import type { ApiRouteHandler } from "./routeHelpers";
import {
  readJsonBodyOrWriteError,
  writeJson,
  writeMethodNotAllowed,
} from "./routeHelpers";

const isString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

// GET /api/claude-brain/drivers — list configured drivers + their live
// health probe results. Used by the upcoming "Drivers" dashboard panel.
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
      maxCostUsd: driver.maxCostUsd,
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
) => {
  if (requestUrl.pathname !== "/api/claude-brain/drivers/dispatch") {
    return false;
  }
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
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
      : process.cwd();
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
