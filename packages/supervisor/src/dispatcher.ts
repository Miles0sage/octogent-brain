import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

import {
  type RoutingConfig,
  type TerminalAgentProvider,
  pickDriverForTask,
} from "@octogent/core";

import type {
  DriverDispatchEvent,
  DriverDispatchResult,
  DriverHealthStatus,
  DriverInvocation,
} from "./dispatch-types";

const SPAWN_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 256 * 1024;

// Health check: does the binary exist on PATH + are required env vars set?
// We deliberately keep this cheap (no `which` shell-out — use `command -v`
// via spawn) so the dispatcher can pick a driver in a few ms.
const checkBinaryOnPath = async (binary: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const child = spawn("command", ["-v", binary], {
      shell: "/bin/bash",
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
};

export const checkProviderHealth = async (
  provider: TerminalAgentProvider,
  config: RoutingConfig,
): Promise<DriverHealthStatus> => {
  const driver = config.drivers.find((d) => d.provider === provider);
  if (!driver) {
    return { healthy: false, reason: "no-driver-for-task", taskType: provider };
  }
  if (driver.transport !== "stdio") {
    return {
      healthy: false,
      reason: "transport-unsupported",
      transport: driver.transport,
    };
  }
  const missingEnv = driver.requiredEnv.filter((key) => !process.env[key]);
  if (missingEnv.length > 0) {
    return { healthy: false, reason: "env-missing", missing: missingEnv };
  }
  const hasBinary = await checkBinaryOnPath(driver.command);
  if (!hasBinary) {
    return { healthy: false, reason: "binary-missing", binary: driver.command };
  }
  return { healthy: true };
};

const buildInvocation = (
  provider: TerminalAgentProvider,
  config: RoutingConfig,
  taskType: string,
  taskInput: string,
  cwd: string,
): DriverInvocation | null => {
  const driver = config.drivers.find((d) => d.provider === provider);
  const rule = config.rules.find((r) => r.taskType === taskType);
  if (!driver) return null;
  const extraArgs = rule?.extraArgs ?? [];
  return {
    provider,
    command: driver.command,
    args: [...driver.baseArgs, ...extraArgs, taskInput],
    cwd,
    envFlags: driver.requiredEnv,
  };
};

const spawnDriver = async (
  invocation: DriverInvocation,
): Promise<{
  events: DriverDispatchEvent[];
  exit_code: number | null;
  duration_ms: number;
}> => {
  const events: DriverDispatchEvent[] = [];
  let bytesOut = 0;
  const startedAt = Date.now();

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      const child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeout = setTimeout(() => {
        events.push({
          kind: "error",
          message: `dispatcher timeout after ${SPAWN_TIMEOUT_MS}ms; killing subprocess`,
        });
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000);
      }, SPAWN_TIMEOUT_MS);

      child.stdout.on("data", (chunk: Buffer) => {
        if (bytesOut >= MAX_OUTPUT_BYTES) return;
        const room = MAX_OUTPUT_BYTES - bytesOut;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        bytesOut += slice.length;
        events.push({ kind: "stdout", data: slice.toString("utf8") });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (bytesOut >= MAX_OUTPUT_BYTES) return;
        const room = MAX_OUTPUT_BYTES - bytesOut;
        const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
        bytesOut += slice.length;
        events.push({ kind: "stderr", data: slice.toString("utf8") });
      });
      child.on("error", (err) => {
        events.push({ kind: "error", message: err.message });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        events.push({ kind: "exit", code, signal });
        resolve({ code, signal });
      });
    },
  );

  return {
    events,
    exit_code: result.code,
    duration_ms: Date.now() - startedAt,
  };
};

export type DispatchRequest = {
  taskType: string;
  taskInput: string;
  cwd: string;
  // When set, the dispatcher returns the planned invocation without
  // spawning. Useful for previewing a routing decision before commit.
  dryRun?: boolean;
};

export const dispatchTask = async (
  config: RoutingConfig,
  request: DispatchRequest,
): Promise<DriverDispatchResult> => {
  const dispatch_id = randomUUID();
  const started_at_iso = new Date().toISOString();

  // Picker uses isHealthy = always true (synchronous), then re-checks the
  // chosen provider's health asynchronously before spawning. Keeps the
  // selection pure while allowing real health probes at spawn time.
  const picked = pickDriverForTask(request.taskType, config, () => true);
  if (!picked) {
    return {
      dispatch_id,
      taskType: request.taskType,
      invocation: null,
      health: { healthy: false, reason: "no-driver-for-task", taskType: request.taskType },
      started_at_iso,
      events: [],
      exit_code: null,
      duration_ms: null,
    };
  }

  const health = await checkProviderHealth(picked, config);
  const invocation = buildInvocation(picked, config, request.taskType, request.taskInput, request.cwd);

  if (!health.healthy || invocation === null) {
    return {
      dispatch_id,
      taskType: request.taskType,
      invocation,
      health,
      started_at_iso,
      events: [],
      exit_code: null,
      duration_ms: null,
    };
  }

  if (request.dryRun === true) {
    return {
      dispatch_id,
      taskType: request.taskType,
      invocation,
      health,
      started_at_iso,
      events: [{ kind: "stdout", data: "[dry-run] not spawned" }],
      exit_code: 0,
      duration_ms: 0,
    };
  }

  const run = await spawnDriver(invocation);
  return {
    dispatch_id,
    taskType: request.taskType,
    invocation,
    health,
    started_at_iso,
    events: run.events,
    exit_code: run.exit_code,
    duration_ms: run.duration_ms,
  };
};

// Suppress unused-import lints kept for future async helpers.
void promisify;
