import { describe, expect, it } from "vitest";

import {
  DEFAULT_ROUTING_CONFIG,
  type RoutingConfig,
  isDriverSpec,
  pickDriverForTask,
  validateRoutingConfig,
} from "../src/domain/driver";
import { isTerminalAgentProvider } from "../src/domain/agentRuntime";

describe("DEFAULT_ROUTING_CONFIG", () => {
  it("contains all four cross-vendor drivers", () => {
    const providers = DEFAULT_ROUTING_CONFIG.drivers.map((d) => d.provider).sort();
    expect(providers).toEqual(["aider", "claude-code", "codex", "gemini-cli"]);
  });

  it("validates against the agent-runtime provider type guard", () => {
    const result = validateRoutingConfig(DEFAULT_ROUTING_CONFIG, isTerminalAgentProvider);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("routes refactor tasks to aider with --architect", () => {
    const rule = DEFAULT_ROUTING_CONFIG.rules.find((r) => r.taskType === "refactor");
    expect(rule?.preferred).toBe("aider");
    expect(rule?.extraArgs).toContain("--architect");
  });

  it("routes verify tasks to claude-code (plan mode is in driver baseArgs)", () => {
    const rule = DEFAULT_ROUTING_CONFIG.rules.find((r) => r.taskType === "verify");
    expect(rule?.preferred).toBe("claude-code");
    // --permission-mode plan moved from per-rule extraArgs into the
    // claude-code driver's baseArgs so every claude-code dispatch is
    // in evaluator mode by default. See driver.ts DEFAULT_ROUTING_CONFIG.
    expect(rule?.extraArgs).toEqual([]);
    const claudeDriver = DEFAULT_ROUTING_CONFIG.drivers.find(
      (d) => d.provider === "claude-code",
    );
    expect(claudeDriver?.transport).toBe("stdio");
    expect(claudeDriver?.baseArgs).toEqual(["--print", "--permission-mode", "plan"]);
  });

  // Wired 2026-05-12: codex migrated from `transport: "pty"` (deferred /
  // health-failed: transport-unsupported) to `transport: "stdio"` using
  // the codex 0.130.0+ `codex exec` non-interactive subcommand. This
  // unblocks codex as the 4th cross-vendor voter in the Generator-
  // Evaluator loop.
  it("codex driver default shape uses `codex exec` non-interactive subcommand", () => {
    const codex = DEFAULT_ROUTING_CONFIG.drivers.find(
      (d) => d.provider === "codex",
    );
    expect(codex).toBeDefined();
    expect(codex?.transport).toBe("stdio");
    expect(codex?.command).toBe("codex");
    expect(codex?.baseArgs).toEqual([
      "exec",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-s",
      "read-only",
    ]);
  });

  it("codex driver default args are SAFE_FLAG_PATTERN-compliant (kebab-case flags + value tokens only)", () => {
    // No standalone SAFE_FLAG_PATTERN validator ships today — the
    // dispatcher relies on (a) DriverSpec.baseArgs being a string[] and
    // (b) the `--` end-of-options separator in buildInvocation to bound
    // user input. As a defensive contract we assert every baseArg token
    // matches a conservative shape: short flags (`-x`), long flags
    // (`--foo`), and bare value tokens of `[A-Za-z0-9_./-]+`. This guards
    // against future drift (e.g. someone appending `--exec='rm -rf /'`).
    const codex = DEFAULT_ROUTING_CONFIG.drivers.find(
      (d) => d.provider === "codex",
    );
    expect(codex).toBeDefined();
    const safeArgPattern = /^(--?[A-Za-z][A-Za-z0-9-]*|[A-Za-z0-9_./-]+)$/;
    for (const arg of codex?.baseArgs ?? []) {
      expect(arg).toMatch(safeArgPattern);
    }
  });

  it("codex driver default args do not include `--dangerously-*` or `--bypass-*` tokens", () => {
    const codex = DEFAULT_ROUTING_CONFIG.drivers.find(
      (d) => d.provider === "codex",
    );
    expect(codex).toBeDefined();
    for (const arg of codex?.baseArgs ?? []) {
      expect(arg).not.toMatch(/^--dangerously-/);
      expect(arg).not.toMatch(/^--bypass-/);
    }
  });
});

describe("validateRoutingConfig", () => {
  it("rejects unsupported version", () => {
    const bad: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      version: 2 as unknown as 1,
    };
    const result = validateRoutingConfig(bad, isTerminalAgentProvider);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "unsupported-version")).toBe(true);
  });

  it("rejects empty drivers + empty rules", () => {
    const bad: RoutingConfig = {
      version: 1,
      drivers: [],
      rules: [],
      defaultProvider: "claude-code",
    };
    const result = validateRoutingConfig(bad, isTerminalAgentProvider);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.kind === "empty-drivers")).toBe(true);
    expect(result.errors.some((e) => e.kind === "empty-rules")).toBe(true);
  });

  it("rejects rule preferred provider not present in drivers", () => {
    const bad: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      rules: [
        ...DEFAULT_ROUTING_CONFIG.rules,
        {
          taskType: "test-only",
          preferred: "aider",
          fallback: ["codex"],
          extraArgs: [],
        },
        {
          taskType: "broken",
          preferred: "gemini-cli",
          fallback: ["claude-code"],
          extraArgs: [],
        },
      ],
      drivers: DEFAULT_ROUTING_CONFIG.drivers.filter(
        (d) => d.provider !== "gemini-cli",
      ),
    };
    const result = validateRoutingConfig(bad, isTerminalAgentProvider);
    expect(result.ok).toBe(false);
    const preferredErr = result.errors.find(
      (e) => e.kind === "rule-preferred-not-in-drivers",
    );
    expect(preferredErr).toBeDefined();
  });

  it("rejects duplicate task types", () => {
    const bad: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      rules: [
        ...DEFAULT_ROUTING_CONFIG.rules,
        {
          taskType: "refactor",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
    };
    const result = validateRoutingConfig(bad, isTerminalAgentProvider);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.kind === "duplicate-task-type" && e.taskType === "refactor",
      ),
    ).toBe(true);
  });

  it("rejects default provider not in drivers", () => {
    const bad: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      defaultProvider: "gemini-cli",
      drivers: DEFAULT_ROUTING_CONFIG.drivers.filter(
        (d) => d.provider !== "gemini-cli",
      ),
    };
    const result = validateRoutingConfig(bad, isTerminalAgentProvider);
    expect(result.ok).toBe(false);
    expect(
      result.errors.some(
        (e) => e.kind === "default-not-in-drivers" && e.provider === "gemini-cli",
      ),
    ).toBe(true);
  });
});

describe("pickDriverForTask", () => {
  it("returns preferred driver when healthy", () => {
    const pick = pickDriverForTask(
      "refactor",
      DEFAULT_ROUTING_CONFIG,
      () => true,
    );
    expect(pick).toBe("aider");
  });

  it("walks fallback chain when preferred unhealthy", () => {
    const pick = pickDriverForTask(
      "refactor",
      DEFAULT_ROUTING_CONFIG,
      (provider) => provider !== "aider",
    );
    expect(pick).toBe("claude-code");
  });

  it("returns null when neither preferred nor fallback nor default is healthy", () => {
    const pick = pickDriverForTask(
      "refactor",
      DEFAULT_ROUTING_CONFIG,
      () => false,
    );
    expect(pick).toBeNull();
  });

  it("returns default driver for unknown task type", () => {
    const pick = pickDriverForTask(
      "unknown-task-type",
      DEFAULT_ROUTING_CONFIG,
      () => true,
    );
    expect(pick).toBe("claude-code");
  });
});

describe("isDriverSpec type guard", () => {
  it("accepts well-formed driver specs", () => {
    for (const driver of DEFAULT_ROUTING_CONFIG.drivers) {
      expect(isDriverSpec(driver, isTerminalAgentProvider)).toBe(true);
    }
  });

  it("rejects driver missing command", () => {
    const bad = {
      provider: "aider",
      transport: "stdio",
      capabilities: ["writer"],
      command: "",
      baseArgs: [],
      requiredEnv: [],
    };
    expect(isDriverSpec(bad, isTerminalAgentProvider)).toBe(false);
  });

  it("rejects driver with unknown transport", () => {
    const bad = {
      provider: "aider",
      transport: "websocket",
      capabilities: ["writer"],
      command: "aider",
      baseArgs: [],
      requiredEnv: [],
    };
    expect(isDriverSpec(bad, isTerminalAgentProvider)).toBe(false);
  });

  // L3 audit M1 (2026-05-12): maxCostUsd was advisory-only — documented
  // but never enforced by the dispatcher. Removed cleanly from DriverSpec
  // rather than half-implementing a cost gate. The type guard MUST NOT
  // require the field anymore, and DEFAULT_ROUTING_CONFIG.drivers MUST
  // not surface it.
  it("does not require maxCostUsd field (removed in L3 audit M1)", () => {
    const minimal = {
      provider: "aider",
      transport: "stdio",
      capabilities: ["writer"],
      command: "aider",
      baseArgs: [],
      requiredEnv: [],
    };
    expect(isDriverSpec(minimal, isTerminalAgentProvider)).toBe(true);
  });

  it("DEFAULT_ROUTING_CONFIG drivers do not surface maxCostUsd", () => {
    for (const driver of DEFAULT_ROUTING_CONFIG.drivers) {
      expect(
        Object.prototype.hasOwnProperty.call(driver, "maxCostUsd"),
      ).toBe(false);
    }
  });
});
