// Cross-vendor CLI Driver interface + routing config.
//
// Rationale (NotebookLM-grounded 2026-05-11): Anthropic shipped agent-view +
// agent-teams as native primitives, so Claude-only orchestration is now
// competing against the OEM. The defensible moat for octogent-brain is
// cross-vendor CLI routing — Aider writes, Claude Code evaluates, Gemini
// gives intel — with a single-writer Generator-Evaluator loop enforced
// mechanically by separate OS processes (Hosico02 + Cognition 2026-04-22).
//
// This module is the type-level scaffold. The concrete drivers live in
// future `packages/drivers/*` (aider stdio, claude-code ACP, gemini-cli
// stdio) and are loaded by the dispatcher in apps/api/src/terminalRuntime
// based on routing.json. We deliberately keep Driver pure-TS with no I/O
// or Node-specific imports so it composes cleanly with the existing
// pure-domain layer.

import type { TerminalAgentProvider } from "./agentRuntime";

// Transport defines HOW the driver talks to the CLI subprocess. New
// transports MUST be added here so the dispatcher can pick the right
// adapter. We list the three that NBLM flagged as production-ready in
// 2026-05.
export type DriverTransport = "stdio" | "acp" | "pty";

// Role this driver can play in a Generator-Evaluator loop. A single
// driver may declare both — e.g., Claude Code can act as either generator
// or evaluator depending on invocation flags (plan-mode vs default).
export type DriverCapability = "writer" | "evaluator" | "intel" | "all";

export type DriverSpec = {
  provider: TerminalAgentProvider;
  transport: DriverTransport;
  capabilities: ReadonlyArray<DriverCapability>;
  // CLI binary name (looked up via PATH) or absolute path.
  command: string;
  // Args appended to every spawn. Per-task args land in RoutingRule.extraArgs.
  baseArgs: ReadonlyArray<string>;
  // env vars that must be present at spawn time. Missing keys = driver
  // unhealthy. Empty array means no requirements.
  requiredEnv: ReadonlyArray<string>;
  // NOTE (L3 audit M1, 2026-05-12): the prior `maxCostUsd: number` field
  // was advisory-only — documented but never enforced by the dispatcher.
  // Removed cleanly rather than half-implementing a cost gate. If a real
  // cost gate is wanted, add it back behind an explicit dispatcher hook
  // so the type contract matches runtime behaviour.
};

// One routing rule maps a task-type keyword to a preferred driver +
// fallback chain. Matched in order; first matching rule wins.
export type RoutingRule = {
  taskType: string;
  preferred: TerminalAgentProvider;
  fallback: ReadonlyArray<TerminalAgentProvider>;
  // Extra args injected into the chosen driver's command line.
  extraArgs: ReadonlyArray<string>;
};

export type RoutingConfig = {
  version: 1;
  drivers: ReadonlyArray<DriverSpec>;
  rules: ReadonlyArray<RoutingRule>;
  // Default driver used when no rule matches a task. Must be present in
  // `drivers`.
  defaultProvider: TerminalAgentProvider;
};

const isDriverTransport = (value: unknown): value is DriverTransport =>
  value === "stdio" || value === "acp" || value === "pty";

const isDriverCapability = (value: unknown): value is DriverCapability =>
  value === "writer" || value === "evaluator" || value === "intel" || value === "all";

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

const isDriverCapabilityArray = (
  value: unknown,
): value is ReadonlyArray<DriverCapability> =>
  Array.isArray(value) && value.every(isDriverCapability);

const isStringArrayOfProviders = (
  value: unknown,
  knownProviders: Iterable<TerminalAgentProvider>,
): value is ReadonlyArray<TerminalAgentProvider> => {
  if (!Array.isArray(value)) return false;
  const set = new Set<string>(knownProviders);
  return value.every((v) => typeof v === "string" && set.has(v));
};

export const isDriverSpec = (
  value: unknown,
  isProvider: (v: unknown) => v is TerminalAgentProvider,
): value is DriverSpec => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (!isProvider(r.provider)) return false;
  if (!isDriverTransport(r.transport)) return false;
  if (!isDriverCapabilityArray(r.capabilities)) return false;
  if (typeof r.command !== "string" || r.command.length === 0) return false;
  if (!isStringArray(r.baseArgs)) return false;
  if (!isStringArray(r.requiredEnv)) return false;
  // maxCostUsd intentionally not validated — see DriverSpec note (L3 M1).
  return true;
};

export type RoutingConfigValidationError =
  | { kind: "missing-version" }
  | { kind: "unsupported-version"; version: number }
  | { kind: "empty-drivers" }
  | { kind: "empty-rules" }
  | { kind: "duplicate-driver"; provider: TerminalAgentProvider }
  | { kind: "default-not-in-drivers"; provider: TerminalAgentProvider }
  | { kind: "rule-preferred-not-in-drivers"; taskType: string; provider: TerminalAgentProvider }
  | { kind: "rule-fallback-not-in-drivers"; taskType: string; provider: TerminalAgentProvider }
  | { kind: "duplicate-task-type"; taskType: string };

export type ValidateRoutingResult = {
  ok: boolean;
  errors: ReadonlyArray<RoutingConfigValidationError>;
};

export const validateRoutingConfig = (
  config: RoutingConfig,
  isProvider: (v: unknown) => v is TerminalAgentProvider,
): ValidateRoutingResult => {
  const errors: RoutingConfigValidationError[] = [];

  if (config.version !== 1) {
    if (typeof config.version !== "number") {
      errors.push({ kind: "missing-version" });
    } else {
      errors.push({ kind: "unsupported-version", version: config.version });
    }
  }

  if (config.drivers.length === 0) {
    errors.push({ kind: "empty-drivers" });
  }
  if (config.rules.length === 0) {
    errors.push({ kind: "empty-rules" });
  }

  const driverProviders = new Set<TerminalAgentProvider>();
  for (const driver of config.drivers) {
    if (driverProviders.has(driver.provider)) {
      errors.push({ kind: "duplicate-driver", provider: driver.provider });
    } else {
      driverProviders.add(driver.provider);
    }
  }

  if (config.drivers.length > 0 && !driverProviders.has(config.defaultProvider)) {
    errors.push({ kind: "default-not-in-drivers", provider: config.defaultProvider });
  }

  const seenTaskTypes = new Set<string>();
  for (const rule of config.rules) {
    if (seenTaskTypes.has(rule.taskType)) {
      errors.push({ kind: "duplicate-task-type", taskType: rule.taskType });
    } else {
      seenTaskTypes.add(rule.taskType);
    }
    if (!driverProviders.has(rule.preferred)) {
      errors.push({
        kind: "rule-preferred-not-in-drivers",
        taskType: rule.taskType,
        provider: rule.preferred,
      });
    }
    for (const fallback of rule.fallback) {
      if (!driverProviders.has(fallback)) {
        errors.push({
          kind: "rule-fallback-not-in-drivers",
          taskType: rule.taskType,
          provider: fallback,
        });
      }
    }
  }

  return { ok: errors.length === 0, errors };
};

// Structural validator for an unknown RoutingRule entry. Used by
// loadRoutingConfig (and exposed publicly for tests / future callers
// that need to validate user-supplied JSON before constructing a
// RoutingConfig). All fields are checked positively — taskType must be
// a non-empty string, preferred must be a known TerminalAgentProvider,
// fallback must be an array of known providers, and extraArgs must be
// an array of strings.
export const isRoutingRule = (
  value: unknown,
  isProvider: (v: unknown) => v is TerminalAgentProvider,
): value is RoutingRule => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.taskType !== "string" || r.taskType.length === 0) return false;
  if (!isProvider(r.preferred)) return false;
  if (!Array.isArray(r.fallback) || !r.fallback.every((v) => isProvider(v))) return false;
  if (!isStringArray(r.extraArgs)) return false;
  return true;
};

// Re-export the providers-array guard so loadRoutingConfig can reuse it
// when it switches from per-field typeof checks to the full type-guard
// surface. (Previously only consumed inside this module.)
export { isStringArrayOfProviders };

// Pick the driver that should handle a given task type. Returns the
// preferred driver if available, else walks the fallback chain. Returns
// null if no candidate is healthy. "Healthy" is caller-defined — pass an
// availability predicate that checks env vars + binary-on-PATH.
export const pickDriverForTask = (
  taskType: string,
  config: RoutingConfig,
  isHealthy: (provider: TerminalAgentProvider) => boolean,
): TerminalAgentProvider | null => {
  const rule = config.rules.find((r) => r.taskType === taskType);
  if (rule) {
    if (isHealthy(rule.preferred)) return rule.preferred;
    for (const fallback of rule.fallback) {
      if (isHealthy(fallback)) return fallback;
    }
  }
  if (isHealthy(config.defaultProvider)) return config.defaultProvider;
  return null;
};

// Default routing config shipped with octogent. Aider writes; Claude Code
// evaluates; Codex stays as today; Gemini-CLI is intel-only. This is the
// "static routing.json for hackathon" cut from the NBLM cut-list.
// Regex used to validate driver command names before any PATH lookup —
// rejects shell metacharacters so a malicious routing.json on disk
// cannot smuggle code execution into the health probe. Per L3 audit C1
// (2026-05-12).
export const SAFE_DRIVER_COMMAND_PATTERN = /^[A-Za-z0-9_./-]+$/;

export const isSafeDriverCommand = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  SAFE_DRIVER_COMMAND_PATTERN.test(value);

// Frozen so consumers cannot mutate the shared default routing chart.
// Typed intermediate so Object.freeze preserves the literal-union types
// (TerminalAgentProvider) rather than widening them to string.
const _defaultRoutingConfig: RoutingConfig = {
  version: 1,
  drivers: [
    {
      provider: "aider",
      transport: "stdio",
      capabilities: ["writer"],
      command: "aider",
      baseArgs: ["--no-pretty", "--yes"],
      requiredEnv: ["OPENAI_API_KEY"],
    },
    {
      provider: "claude-code",
      transport: "stdio",
      capabilities: ["writer", "evaluator", "all"],
      command: "claude",
      // `claude --print` is the native non-interactive mode (read CLI
      // help: "Print response and exit, useful for pipes"). Combined
      // with --permission-mode plan it acts as a clean-context
      // read-only evaluator: no edits, no shared state with the writer.
      baseArgs: ["--print", "--permission-mode", "plan"],
      // Empty: Claude Code uses keychain / OAuth by default; an
      // ANTHROPIC_API_KEY env var is required only with --bare.
      requiredEnv: [],
    },
    // Wired 2026-05-12 — codex 0.130.0+ ships `codex exec` non-interactive
    // subcommand. Was `pty` (deferred, health-failed: transport-
    // unsupported) prior to this date. The baseArgs configure codex as a
    // clean-stdout, read-only evaluator: `--color never` strips ANSI so
    // stdout is parseable; `--skip-git-repo-check` lets it run outside a
    // git repo (test envs, /tmp cwds); `-s read-only` sandboxes fs access
    // so the voter cannot mutate the workspace it's evaluating.
    {
      provider: "codex",
      transport: "stdio",
      capabilities: ["writer", "evaluator"],
      command: "codex",
      baseArgs: ["exec", "--color", "never", "--skip-git-repo-check", "-s", "read-only"],
      requiredEnv: ["OPENAI_API_KEY"],
    },
    {
      provider: "gemini-cli",
      transport: "stdio",
      capabilities: ["intel"],
      command: "gemini",
      baseArgs: [],
      requiredEnv: ["GOOGLE_API_KEY"],
    },
  ],
  rules: [
    {
      taskType: "refactor",
      preferred: "aider",
      fallback: ["claude-code"],
      extraArgs: ["--architect"],
    },
    {
      taskType: "verify",
      preferred: "claude-code",
      fallback: ["codex"],
      // --permission-mode plan lives in claude-code's baseArgs now so
      // every claude-code dispatch is in evaluator/plan mode by default.
      extraArgs: [],
    },
    {
      taskType: "research",
      preferred: "gemini-cli",
      fallback: ["claude-code"],
      extraArgs: [],
    },
    {
      taskType: "default",
      preferred: "claude-code",
      fallback: ["codex", "aider"],
      extraArgs: [],
    },
  ],
  defaultProvider: "claude-code",
};

export const DEFAULT_ROUTING_CONFIG: Readonly<RoutingConfig> =
  Object.freeze(_defaultRoutingConfig);
