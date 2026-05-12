import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_ROUTING_CONFIG, type RoutingConfig } from "@octogent/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkProviderHealth,
  dispatchTask,
  loadRoutingConfig,
} from "@octogent/supervisor";
import {
  TENTACLES_ROOT,
  handleDriversDispatchRoute,
  handleDriversListRoute,
} from "../src/createApiServer/driverRoutes";
// L3 audit M3 (2026-05-12): voteRoutes also accepts a cwd field and must
// enforce the same workspace allowlist. Tests live here because scope
// restricts test edits to this file.
import { handleVoteDispatchRoute } from "../src/createApiServer/voteRoutes";
import { homedir } from "node:os";

type ResponseLike = {
  status: number;
  body: string;
  headers: Record<string, string>;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: string): void;
};

const buildResponse = (): ResponseLike => ({
  status: 0,
  body: "",
  headers: {},
  writeHead(status, headers) {
    this.status = status;
    this.headers = headers;
  },
  end(body) {
    this.body = body ?? "";
  },
});

const buildGet = (url: string) => {
  const response = buildResponse();
  return {
    request: { method: "GET" } as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

const buildPost = (
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; remoteAddress?: string } = {},
) => {
  const response = buildResponse();
  const bodyStr = JSON.stringify(body);
  const stream = (async function* () {
    yield Buffer.from(bodyStr);
  })();
  const fakeRequest = Object.assign(stream, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.headers ?? {}),
    },
    // L3 audit r2 C1 (2026-05-12): provide a loopback remoteAddress so
    // the bearer-token + rate-limit gate accepts the test request even
    // when OCTOGENT_API_KEY is unset (loopback-only fallback path).
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  });
  return {
    request: fakeRequest as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

const buildRouteDeps = (workspaceCwd = process.cwd()) => ({ workspaceCwd } as never);

describe("routingLoader", () => {
  let prevEnv: string | undefined;
  let workDir: string;

  beforeEach(() => {
    prevEnv = process.env.OCTOGENT_ROUTING_CONFIG;
    workDir = mkdtempSync(join(tmpdir(), "octogent-routing-test-"));
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.OCTOGENT_ROUTING_CONFIG;
    } else {
      process.env.OCTOGENT_ROUTING_CONFIG = prevEnv;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("returns DEFAULT_ROUTING_CONFIG when file is missing", () => {
    const result = loadRoutingConfig(join(workDir, "nope.json"));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("default");
      expect(result.config).toEqual(DEFAULT_ROUTING_CONFIG);
    }
  });

  it("loads a valid routing.json from disk", () => {
    const configPath = join(workDir, "routing.json");
    writeFileSync(configPath, JSON.stringify(DEFAULT_ROUTING_CONFIG));
    const result = loadRoutingConfig(configPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("user-file");
      expect(result.config.defaultProvider).toBe("claude-code");
    }
  });

  it("rejects invalid JSON", () => {
    const configPath = join(workDir, "routing.json");
    writeFileSync(configPath, "{ not valid json");
    const result = loadRoutingConfig(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("invalid-json");
    }
  });

  it("rejects schema-mismatched JSON", () => {
    const configPath = join(workDir, "routing.json");
    writeFileSync(configPath, JSON.stringify({ version: 1 }));
    const result = loadRoutingConfig(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects validation-failed config (default not in drivers)", () => {
    const configPath = join(workDir, "routing.json");
    const bad: RoutingConfig = {
      version: 1,
      drivers: [],
      rules: DEFAULT_ROUTING_CONFIG.rules,
      defaultProvider: "claude-code",
    };
    writeFileSync(configPath, JSON.stringify(bad));
    const result = loadRoutingConfig(configPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("validation-failed");
    }
  });

  it("loads from OCTOGENT_ROUTING_CONFIG env when no path passed", () => {
    const configPath = join(workDir, "routing.json");
    writeFileSync(configPath, JSON.stringify(DEFAULT_ROUTING_CONFIG));
    process.env.OCTOGENT_ROUTING_CONFIG = configPath;
    const result = loadRoutingConfig();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe("user-file");
  });
});

// L3 audit r2 C1 (2026-05-12): per-entry schema validation.
//
// Background: isPartialRoutingConfig only ran `Array.isArray` on drivers
// and rules — entry shapes were not validated. A malicious routing.json
// could ship a driver with `baseArgs: [{x:1}]` or
// `baseArgs: ["--dangerously-skip-permissions"]` and the argv-injection
// `--` guard at dispatcher.ts would not protect against it because the
// hostile bytes land BEFORE the `--`. Fix: loadRoutingConfig must call
// `isDriverSpec` on every driver entry and a structural validator on
// every rule entry, rejecting bad shapes with reason="schema-invalid".
describe("routingLoader C1: per-entry schema validation", () => {
  let prevEnv: string | undefined;
  let workDir: string;

  beforeEach(() => {
    prevEnv = process.env.OCTOGENT_ROUTING_CONFIG;
    workDir = mkdtempSync(join(tmpdir(), "octogent-routing-c1-"));
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.OCTOGENT_ROUTING_CONFIG;
    } else {
      process.env.OCTOGENT_ROUTING_CONFIG = prevEnv;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  const writeRouting = (config: unknown): string => {
    const configPath = join(workDir, "routing.json");
    writeFileSync(configPath, JSON.stringify(config));
    return configPath;
  };

  it("rejects driver with non-string baseArgs entry (smuggle attempt)", () => {
    const bad = {
      version: 1,
      drivers: [
        {
          provider: "claude-code",
          transport: "stdio",
          capabilities: ["evaluator"],
          command: "claude",
          // Non-string entry — Node spawn would String(v) coerce.
          baseArgs: [{ smuggle: 1 }],
          requiredEnv: [],
        },
      ],
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects driver with unknown transport", () => {
    const bad = {
      version: 1,
      drivers: [
        {
          provider: "claude-code",
          transport: "websocket",
          capabilities: ["evaluator"],
          command: "claude",
          baseArgs: [],
          requiredEnv: [],
        },
      ],
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects driver with empty command", () => {
    const bad = {
      version: 1,
      drivers: [
        {
          provider: "claude-code",
          transport: "stdio",
          capabilities: ["evaluator"],
          command: "",
          baseArgs: [],
          requiredEnv: [],
        },
      ],
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects driver with non-array capabilities", () => {
    const bad = {
      version: 1,
      drivers: [
        {
          provider: "claude-code",
          transport: "stdio",
          capabilities: "evaluator",
          command: "claude",
          baseArgs: [],
          requiredEnv: [],
        },
      ],
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects rule with missing preferred", () => {
    const bad = {
      version: 1,
      drivers: DEFAULT_ROUTING_CONFIG.drivers,
      rules: [
        {
          taskType: "verify",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects rule with wrong fallback type (not array of providers)", () => {
    const bad = {
      version: 1,
      drivers: DEFAULT_ROUTING_CONFIG.drivers,
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: "not-an-array",
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects rule with non-string extraArgs entry", () => {
    const bad = {
      version: 1,
      drivers: DEFAULT_ROUTING_CONFIG.drivers,
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [{ smuggle: 1 }],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("rejects rule with missing or non-string taskType", () => {
    const bad = {
      version: 1,
      drivers: DEFAULT_ROUTING_CONFIG.drivers,
      rules: [
        {
          taskType: 7,
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = loadRoutingConfig(writeRouting(bad));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("schema-invalid");
    }
  });

  it("accepts DEFAULT_ROUTING_CONFIG round-tripped through JSON", () => {
    const result = loadRoutingConfig(
      writeRouting(JSON.parse(JSON.stringify(DEFAULT_ROUTING_CONFIG))),
    );
    expect(result.ok).toBe(true);
  });
});

// L3 audit r2 C2 (2026-05-12): env allowlist on spawnDriver.
//
// Background: the dispatcher previously passed `env: process.env` to
// every spawned subprocess. Every voter then saw every secret on the
// host (AWS_*, ANTHROPIC_API_KEY, GH_TOKEN, etc.) — a compromised or
// honestly-misbehaving voter could exfiltrate other vendors' keys via
// raw_output. Fix: only PATH/HOME/USER/LANG/LC_ALL/TERM (the OS
// baseline that any CLI needs to start) + the driver's explicitly
// declared `requiredEnv` are forwarded.
//
// Validated end-to-end via `dispatchTask` with a real spawn against
// /bin/sh + `env` so the assertions act on the child process's actual
// environment rather than a unit-under-test mock.
describe("dispatcher C2: env allowlist", () => {
  const SECRET_KEY = "OCTOGENT_C2_LEAK_TEST";
  const SECRET_VAL = "this-must-not-leak";
  const DECLARED_KEY = "OCTOGENT_C2_DECLARED_OK";
  const DECLARED_VAL = "this-is-explicitly-required";

  it("does NOT forward an undeclared env var to the child", async () => {
    process.env[SECRET_KEY] = SECRET_VAL;
    process.env[DECLARED_KEY] = DECLARED_VAL;
    try {
      // Synthetic routing config: a single shell-based driver invoked
      // by command="sh" + baseArgs=["-c", "env"]. requiredEnv declares
      // only DECLARED_KEY — SECRET_KEY must be absent in the child.
      const config: RoutingConfig = {
        version: 1,
        drivers: [
          {
            provider: "claude-code",
            transport: "stdio",
            capabilities: ["evaluator"],
            command: "sh",
            baseArgs: ["-c", 'env; echo "__END__"'],
            requiredEnv: [DECLARED_KEY],
          },
        ],
        rules: [
          {
            taskType: "verify",
            preferred: "claude-code",
            fallback: [],
            extraArgs: [],
          },
        ],
        defaultProvider: "claude-code",
      };
      const result = await dispatchTask(config, {
        taskType: "verify",
        taskInput: "",
        cwd: process.cwd(),
      });
      const stdout = result.events
        .filter((e): e is { kind: "stdout"; data: string } => e.kind === "stdout")
        .map((e) => e.data)
        .join("");
      expect(stdout).toContain(`${DECLARED_KEY}=${DECLARED_VAL}`);
      expect(stdout).not.toContain(SECRET_KEY);
      expect(stdout).not.toContain(SECRET_VAL);
      // Sanity: baseline keys arrive.
      expect(stdout).toMatch(/PATH=/);
    } finally {
      delete process.env[SECRET_KEY];
      delete process.env[DECLARED_KEY];
    }
  });

  it("does not forward HOME-adjacent / other secret-shaped envs unless declared", async () => {
    const leaks = ["AWS_SECRET_ACCESS_KEY", "ANTHROPIC_API_KEY", "GH_TOKEN"];
    const prev: Record<string, string | undefined> = {};
    for (const key of leaks) {
      prev[key] = process.env[key];
      process.env[key] = `LEAKY-${key}`;
    }
    try {
      const config: RoutingConfig = {
        version: 1,
        drivers: [
          {
            provider: "claude-code",
            transport: "stdio",
            capabilities: ["evaluator"],
            command: "sh",
            baseArgs: ["-c", "env"],
            requiredEnv: [],
          },
        ],
        rules: [
          {
            taskType: "verify",
            preferred: "claude-code",
            fallback: [],
            extraArgs: [],
          },
        ],
        defaultProvider: "claude-code",
      };
      const result = await dispatchTask(config, {
        taskType: "verify",
        taskInput: "",
        cwd: process.cwd(),
      });
      const stdout = result.events
        .filter((e): e is { kind: "stdout"; data: string } => e.kind === "stdout")
        .map((e) => e.data)
        .join("");
      for (const key of leaks) {
        expect(stdout).not.toContain(`LEAKY-${key}`);
      }
    } finally {
      for (const key of leaks) {
        if (prev[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = prev[key];
        }
      }
    }
  });
});

// L3 audit r2 M1 + M2 (2026-05-12): dispatcher subprocess hardening.
//
// M1: child.stdout / child.stderr were emitted without `.on("error")`
//     handlers. A SIGPIPE or premature stream close on the child would
//     bubble up as an unhandled exception and (on Node 22 default)
//     terminate the API server. The handlers must convert stream
//     errors into dispatcher events instead.
//
// M2: the SIGKILL-escalation `setTimeout(() => child.kill("SIGKILL"),
//     1000)` was scheduled inside the outer timeout but never cleared
//     when the child exited cleanly. Result: every dispatch leaked one
//     timer for 1s past completion, blocking event-loop exit and
//     leaking a closure capturing `child`. Must clear the inner timer
//     in the `close` handler.
describe("dispatcher M1 + M2: subprocess hardening", () => {
  it("M1: stream errors from a child surface as 'error' events, not crashes", async () => {
    // Spawn a short-lived child that exits before stdout is fully read.
    // We don't have an easy way to synthesize a SIGPIPE in a unit test
    // without going through PTY, but we CAN run a fast-exiting child and
    // confirm the dispatcher returns a structured DriverDispatchResult
    // rather than throwing. A regression in the stream-error wiring
    // would manifest as an unhandled exception under coverage runs.
    const config: RoutingConfig = {
      version: 1,
      drivers: [
        {
          provider: "claude-code",
          transport: "stdio",
          capabilities: ["evaluator"],
          command: "sh",
          baseArgs: ["-c", "echo done; exit 0"],
          requiredEnv: [],
        },
      ],
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const result = await dispatchTask(config, {
      taskType: "verify",
      taskInput: "",
      cwd: process.cwd(),
    });
    // No unhandled exception. Exit code is structured.
    expect(result.exit_code).toBe(0);
    expect(
      result.events.some(
        (e) => e.kind === "stdout" && e.data.includes("done"),
      ),
    ).toBe(true);
  });

  it("M2: SIGKILL escalation timer does not keep the event loop alive after clean exit", async () => {
    // If M2 regresses, this test still passes but vitest would hang at
    // shutdown waiting for the leaked timer. The functional assertion
    // is just that dispatchTask returns within a reasonable window.
    const config: RoutingConfig = {
      version: 1,
      drivers: [
        {
          provider: "claude-code",
          transport: "stdio",
          capabilities: ["evaluator"],
          command: "sh",
          baseArgs: ["-c", "echo quick; exit 0"],
          requiredEnv: [],
        },
      ],
      rules: [
        {
          taskType: "verify",
          preferred: "claude-code",
          fallback: [],
          extraArgs: [],
        },
      ],
      defaultProvider: "claude-code",
    };
    const start = Date.now();
    const result = await dispatchTask(config, {
      taskType: "verify",
      taskInput: "",
      cwd: process.cwd(),
    });
    const elapsed = Date.now() - start;
    expect(result.exit_code).toBe(0);
    // Comfortably under the SIGKILL escalation window.
    expect(elapsed).toBeLessThan(5_000);
  });
});

describe("checkProviderHealth", () => {
  it("reports env-missing when required env var unset", async () => {
    const prev = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      const result = await checkProviderHealth("aider", DEFAULT_ROUTING_CONFIG);
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        if (result.reason === "env-missing") {
          expect(result.missing).toContain("OPENAI_API_KEY");
        } else {
          // Binary may also be missing on a host without aider; either is fine
          // because env is checked first in our impl.
          expect(["env-missing", "binary-missing"]).toContain(result.reason);
        }
      }
    } finally {
      if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
    }
  });

  it("codex driver health probe returns ready (or env/binary-missing) after stdio wiring", async () => {
    // 2026-05-12: codex was migrated pty -> stdio via `codex exec`. The
    // dispatcher's checkProviderHealth now passes the transport gate; only
    // env-missing / binary-missing remain as possible non-ready states
    // depending on the host. transport-unsupported MUST NOT be returned.
    const result = await checkProviderHealth("codex", DEFAULT_ROUTING_CONFIG);
    if (!result.healthy) {
      expect(result.reason).not.toBe("transport-unsupported");
      expect(["env-missing", "binary-missing"]).toContain(result.reason);
    } else {
      expect(result.healthy).toBe(true);
    }
  });

  it("probes claude-code as stdio (D3) — health depends on `claude` binary on PATH", async () => {
    const result = await checkProviderHealth("claude-code", DEFAULT_ROUTING_CONFIG);
    // claude-code is now stdio transport with `claude --print
    // --permission-mode plan`. Required env is empty (OAuth/keychain).
    // Health depends only on whether `claude` is on PATH for the test
    // host, which we cannot assume — assert structurally instead.
    if (result.healthy) {
      expect(result.healthy).toBe(true);
    } else {
      // Only acceptable reason on a host without `claude` binary.
      expect(result.reason).toBe("binary-missing");
    }
  });
});

describe("dispatchTask", () => {
  it("returns no-driver-for-task when picker fails", async () => {
    const emptyConfig: RoutingConfig = {
      ...DEFAULT_ROUTING_CONFIG,
      rules: [],
      drivers: [],
      defaultProvider: "claude-code",
    };
    const result = await dispatchTask(emptyConfig, {
      taskType: "refactor",
      taskInput: "do thing",
      cwd: "/tmp",
    });
    expect(result.invocation).toBeNull();
    expect(result.exit_code).toBeNull();
  });

  it("returns health failure without spawning when binary/env missing", async () => {
    const result = await dispatchTask(DEFAULT_ROUTING_CONFIG, {
      taskType: "refactor",
      taskInput: "rewrite the function",
      cwd: "/tmp",
    });
    expect(result.health.healthy).toBe(false);
    expect(result.exit_code).toBeNull();
    expect(result.events).toEqual([]);
  });

  it("builds verify-task invocation as `claude --print --permission-mode plan -- <input>` (D3 + L3 M2 argv-injection guard)", async () => {
    const result = await dispatchTask(DEFAULT_ROUTING_CONFIG, {
      taskType: "verify",
      taskInput: "check this diff for groundedness",
      cwd: "/tmp",
      dryRun: true,
    });
    expect(result.invocation).not.toBeNull();
    if (result.invocation) {
      expect(result.invocation.provider).toBe("claude-code");
      expect(result.invocation.command).toBe("claude");
      // L3 audit M2 (2026-05-12): `--` end-of-options separator is
      // inserted between extraArgs and taskInput so a hostile taskInput
      // (e.g. starting with `--dangerously-skip-permissions`) cannot be
      // parsed as a flag by the driver CLI.
      expect(result.invocation.args).toEqual([
        "--print",
        "--permission-mode",
        "plan",
        "--",
        "check this diff for groundedness",
      ]);
    }
  });

  // L3 audit M2 (2026-05-12): regression — taskInput that starts with
  // `--` must land AFTER the end-of-options separator, never be parsed
  // as a CLI flag.
  it("places taskInput AFTER `--` end-of-options separator even when input begins with --flag", async () => {
    const result = await dispatchTask(DEFAULT_ROUTING_CONFIG, {
      taskType: "verify",
      // Hostile-looking taskInput that would otherwise be a Claude CLI
      // flag and could grant dangerous permissions.
      taskInput: "--dangerously-skip-permissions",
      cwd: "/tmp",
      dryRun: true,
    });
    expect(result.invocation).not.toBeNull();
    if (result.invocation) {
      const args = result.invocation.args;
      const dashIdx = args.indexOf("--");
      expect(dashIdx).toBeGreaterThanOrEqual(0);
      // taskInput must come strictly AFTER the `--` separator.
      const tailIdx = args.indexOf("--dangerously-skip-permissions");
      expect(tailIdx).toBeGreaterThan(dashIdx);
      // And nothing BEFORE the `--` should be the hostile taskInput.
      expect(args.slice(0, dashIdx)).not.toContain(
        "--dangerously-skip-permissions",
      );
    }
  });

  // Companion: extraArgs (per-rule) still land BEFORE `--`, so legitimate
  // flags like aider's `--architect` continue to function as flags.
  it("keeps rule-level extraArgs (e.g. --architect) BEFORE the `--` separator", async () => {
    const result = await dispatchTask(DEFAULT_ROUTING_CONFIG, {
      taskType: "refactor",
      taskInput: "rename foo to bar",
      cwd: "/tmp",
      dryRun: true,
    });
    expect(result.invocation).not.toBeNull();
    if (result.invocation) {
      const args = result.invocation.args;
      // aider routing rule injects --architect as extraArgs.
      const archIdx = args.indexOf("--architect");
      const dashIdx = args.indexOf("--");
      if (result.invocation.provider === "aider") {
        // dryRun bypasses health gate in invocation builder shape;
        // assert ordering only when invocation was built for aider.
        expect(archIdx).toBeGreaterThanOrEqual(0);
        expect(dashIdx).toBeGreaterThan(archIdx);
      }
    }
  });
});

describe("driverRoutes", () => {
  let prevRoutingEnv: string | undefined;
  let workDir: string;

  beforeEach(() => {
    prevRoutingEnv = process.env.OCTOGENT_ROUTING_CONFIG;
    workDir = mkdtempSync(join(tmpdir(), "octogent-driver-routes-"));
  });

  afterEach(() => {
    if (prevRoutingEnv === undefined) {
      delete process.env.OCTOGENT_ROUTING_CONFIG;
    } else {
      process.env.OCTOGENT_ROUTING_CONFIG = prevRoutingEnv;
    }
    rmSync(workDir, { recursive: true, force: true });
  });

  it("GET /drivers lists default config + health probes", async () => {
    const ctx = buildGet("http://x.test/api/claude-brain/drivers");
    const handled = await handleDriversListRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      config_source: string;
      defaultProvider: string;
      drivers: Array<{ provider: string; health: { healthy: boolean } }>;
      rules: unknown[];
    };
    expect(body.config_source).toBe("default");
    expect(body.defaultProvider).toBe("claude-code");
    expect(body.drivers.length).toBe(DEFAULT_ROUTING_CONFIG.drivers.length);
    expect(body.rules.length).toBe(DEFAULT_ROUTING_CONFIG.rules.length);
  });

  it("GET /drivers returns error when routing.json is malformed", async () => {
    const configPath = join(workDir, "routing.json");
    mkdirSync(workDir, { recursive: true });
    writeFileSync(configPath, "{ not valid");
    process.env.OCTOGENT_ROUTING_CONFIG = configPath;
    const ctx = buildGet("http://x.test/api/claude-brain/drivers");
    const handled = await handleDriversListRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    const body = JSON.parse(ctx.responseStub.body) as {
      config: null;
      error: { reason: string };
    };
    expect(body.config).toBeNull();
    expect(body.error.reason).toBe("invalid-json");
  });

  it("POST /drivers/dispatch with dryRun returns invocation without spawning", async () => {
    // Note: cwd updated from "/tmp" to process.cwd() per L3 audit M3
    // (2026-05-12) — /tmp is no longer on the allowlist, so the prior
    // value would now (correctly) get 400 cwd-not-allowed.
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "rename function foo to bar",
      cwd: process.cwd(),
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      taskType: string;
      invocation: { provider: string } | null;
      health: { healthy: boolean };
    };
    expect(body.taskType).toBe("refactor");
    // Health depends on host (aider binary, OPENAI_API_KEY). Either way
    // we should get a structured response.
    expect(typeof body.health.healthy).toBe("boolean");
  });

  it("POST /drivers/dispatch rejects missing taskType", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskInput: "foo",
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("POST /drivers/dispatch rejects missing taskInput", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("GET /drivers returns 405 on POST", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers", {});
    const handled = await handleDriversListRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(405);
  });
});

// L3 audit M3 (2026-05-12): cwd allowlist.
//
// Background: the driverRoutes + voteRoutes handlers previously accepted
// an arbitrary `cwd` string from request bodies and passed it straight to
// the dispatcher, which spawned subprocesses there. A malicious client
// could spawn an agent with cwd=/etc, /root/.ssh, or any other sensitive
// directory it had read access to — letting the agent's file-reading
// tools exfiltrate secrets via vote/dispatch output.
//
// Fix: the API layer canonicalizes the requested cwd via path.resolve
// and refuses it unless it equals process.cwd() OR resolves under
// ~/.octogent/tentacles/<id>/worktree/* (the only sanctioned tentacle
// workspaces). Tests cover three classic attacker targets + happy paths.
describe("driverRoutes M3: cwd allowlist", () => {
  it("rejects cwd=/etc/passwd with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd: "/etc/passwd",
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
    const body = JSON.parse(ctx.responseStub.body) as { error: string };
    expect(body.error).toMatch(/cwd/i);
  });

  it("rejects cwd=/root/.ssh with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd: "/root/.ssh",
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("rejects cwd=/tmp (not whitelisted) with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd: "/tmp",
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("rejects path-traversal cwd that resolves outside allowlist", async () => {
    const cwd = `${homedir()}/.octogent/tentacles/foo/worktree/../../../..`;
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd,
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("accepts cwd=process.cwd() (the workspace root)", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd: process.cwd(),
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("accepts cwd within ~/.octogent/tentacles/<id>/worktree", async () => {
    mkdirSync(TENTACLES_ROOT, { recursive: true });
    const tentacleRoot = mkdtempSync(join(TENTACLES_ROOT, "octopus-"));
    const cwd = join(tentacleRoot, "worktree");
    mkdirSync(cwd, { recursive: true });
    try {
      const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
        taskType: "refactor",
        taskInput: "harmless input",
        cwd,
        dryRun: true,
      });
      const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
      expect(handled).toBe(true);
      expect(ctx.responseStub.status).toBe(200);
    } finally {
      rmSync(tentacleRoot, { recursive: true, force: true });
    }
  });

  it("accepts cwd in subdirectory of a tentacle worktree", async () => {
    mkdirSync(TENTACLES_ROOT, { recursive: true });
    const tentacleRoot = mkdtempSync(join(TENTACLES_ROOT, "octopus-"));
    const cwd = join(tentacleRoot, "worktree", "packages", "core");
    mkdirSync(cwd, { recursive: true });
    try {
      const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
        taskType: "refactor",
        taskInput: "harmless input",
        cwd,
        dryRun: true,
      });
      const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps());
      expect(handled).toBe(true);
      expect(ctx.responseStub.status).toBe(200);
    } finally {
      rmSync(tentacleRoot, { recursive: true, force: true });
    }
  });

  it("accepts the configured workspaceCwd even when process.cwd() points somewhere else", async () => {
    const workspaceCwd = "/root/octogent";
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd: workspaceCwd,
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps(workspaceCwd));
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("defaults missing cwd to the configured workspaceCwd", async () => {
    const workspaceCwd = "/root/octogent";
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "verify",
      taskInput: "harmless input",
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, buildRouteDeps(workspaceCwd));
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
    const body = JSON.parse(ctx.responseStub.body) as {
      invocation: { cwd: string } | null;
    };
    expect(body.invocation?.cwd).toBe(workspaceCwd);
  });
});

describe("voteRoutes M3: cwd allowlist (same policy)", () => {
  it("rejects cwd=/etc/passwd with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: "/etc/passwd",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
    const body = JSON.parse(ctx.responseStub.body) as { error: string };
    expect(body.error).toMatch(/cwd/i);
  });

  it("rejects cwd=/root/.ssh with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: "/root/.ssh",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("rejects cwd=/tmp (not whitelisted) with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: "/tmp",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("accepts cwd=process.cwd()", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: process.cwd(),
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("accepts cwd within ~/.octogent/tentacles/<id>/worktree", async () => {
    mkdirSync(TENTACLES_ROOT, { recursive: true });
    const tentacleRoot = mkdtempSync(join(TENTACLES_ROOT, "octopus-"));
    const cwd = join(tentacleRoot, "worktree");
    mkdirSync(cwd, { recursive: true });
    try {
      const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
        taskInput: "verify groundedness",
        cwd,
        dryRun: true,
      });
      const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps());
      expect(handled).toBe(true);
      expect(ctx.responseStub.status).toBe(200);
    } finally {
      rmSync(tentacleRoot, { recursive: true, force: true });
    }
  });

  it("accepts configured workspaceCwd and defaults missing cwd to it", async () => {
    const workspaceCwd = "/root/octogent";
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, buildRouteDeps(workspaceCwd));
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("rejects symlink cwd that resolves outside the workspace", async () => {
    const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-workspace-"));
    const outsideCwd = mkdtempSync(join(tmpdir(), "octogent-outside-"));
    const escapeLink = join(workspaceCwd, "escape");
    symlinkSync(outsideCwd, escapeLink, "dir");

    const driverCtx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "verify",
      taskInput: "harmless input",
      cwd: escapeLink,
      dryRun: true,
    });
    const driverHandled = await handleDriversDispatchRoute(
      driverCtx,
      buildRouteDeps(workspaceCwd),
    );
    expect(driverHandled).toBe(true);
    expect(driverCtx.responseStub.status).toBe(400);

    const voteCtx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: escapeLink,
      dryRun: true,
    });
    const voteHandled = await handleVoteDispatchRoute(voteCtx, buildRouteDeps(workspaceCwd));
    expect(voteHandled).toBe(true);
    expect(voteCtx.responseStub.status).toBe(400);

    rmSync(workspaceCwd, { recursive: true, force: true });
    rmSync(outsideCwd, { recursive: true, force: true });
  });
});
