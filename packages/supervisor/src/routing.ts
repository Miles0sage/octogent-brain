import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_ROUTING_CONFIG,
  isDriverSpec,
  isRoutingRule,
  isTerminalAgentProvider,
  type RoutingConfig,
  validateRoutingConfig,
} from "@octogent/core";

// Resolve the routing.json path. Env-first so tests can point at a fixture;
// otherwise ~/.octogent-better/routing.json (the convention referenced in
// the routing.example.json shipped at repo root).
export const resolveRoutingPath = (): string =>
  process.env.OCTOGENT_ROUTING_CONFIG?.trim() ||
  join(homedir(), ".octogent-better", "routing.json");

// Top-level shape check. The per-entry validation in `isFullRoutingConfig`
// below is the load-bearing security gate — this just narrows to a shape
// that has the right top-level fields before we iterate.
const isPartialRoutingConfig = (value: unknown): value is RoutingConfig => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r.version !== 1) return false;
  if (!Array.isArray(r.drivers)) return false;
  if (!Array.isArray(r.rules)) return false;
  if (typeof r.defaultProvider !== "string") return false;
  return true;
};

// Per-entry shape check. Every driver in `config.drivers` must satisfy
// `isDriverSpec` (well-formed transport, capability array, command,
// baseArgs string[], requiredEnv string[]). Every rule in `config.rules`
// must satisfy `isRoutingRule` (taskType non-empty string, preferred a
// known provider, fallback a provider array, extraArgs a string array).
// This closes L3-r2 C1: previously the loader only ran `Array.isArray`
// on drivers/rules, leaving an open hole where a hostile routing.json
// could ship `extraArgs: [{...}]` or `baseArgs: [{...}]` that the
// dispatcher's `--` argv guard wouldn't protect (because the hostile
// entries land BEFORE `--`).
const isFullRoutingConfig = (config: RoutingConfig): string | null => {
  for (let i = 0; i < config.drivers.length; i++) {
    if (!isDriverSpec(config.drivers[i], isTerminalAgentProvider)) {
      return `drivers[${i}] failed isDriverSpec`;
    }
  }
  for (let i = 0; i < config.rules.length; i++) {
    if (!isRoutingRule(config.rules[i], isTerminalAgentProvider)) {
      return `rules[${i}] failed isRoutingRule`;
    }
  }
  return null;
};

export type RoutingLoadResult =
  | { ok: true; config: RoutingConfig; source: "user-file" | "default" }
  | { ok: false; reason: "invalid-json"; path: string; detail: string }
  | { ok: false; reason: "schema-invalid"; path: string; errors: ReadonlyArray<string> }
  | { ok: false; reason: "validation-failed"; path: string; errors: ReadonlyArray<string> };

// Loads ~/.octogent-better/routing.json when present, otherwise returns
// DEFAULT_ROUTING_CONFIG. Validation errors are surfaced rather than
// silently dropping back to the default — that is the contract the
// dispatcher needs to refuse to spawn against a misconfigured chart.
export const loadRoutingConfig = (path?: string): RoutingLoadResult => {
  const resolvedPath = path ?? resolveRoutingPath();
  if (!existsSync(resolvedPath)) {
    return { ok: true, config: DEFAULT_ROUTING_CONFIG, source: "default" };
  }

  let raw: string;
  try {
    raw = readFileSync(resolvedPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-json",
      path: resolvedPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "invalid-json",
      path: resolvedPath,
      detail: err instanceof Error ? err.message : String(err),
    };
  }

  if (!isPartialRoutingConfig(parsed)) {
    return {
      ok: false,
      reason: "schema-invalid",
      path: resolvedPath,
      errors: ["routing.json must be a RoutingConfig with version=1, drivers[], rules[], defaultProvider"],
    };
  }

  const perEntryError = isFullRoutingConfig(parsed);
  if (perEntryError !== null) {
    return {
      ok: false,
      reason: "schema-invalid",
      path: resolvedPath,
      errors: [perEntryError],
    };
  }

  const validation = validateRoutingConfig(parsed, isTerminalAgentProvider);
  if (!validation.ok) {
    return {
      ok: false,
      reason: "validation-failed",
      path: resolvedPath,
      errors: validation.errors.map((e) => JSON.stringify(e)),
    };
  }

  return { ok: true, config: parsed, source: "user-file" };
};
