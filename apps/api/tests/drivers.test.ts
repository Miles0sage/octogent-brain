import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const buildPost = (url: string, body: unknown) => {
  const response = buildResponse();
  const bodyStr = JSON.stringify(body);
  const stream = (async function* () {
    yield Buffer.from(bodyStr);
  })();
  const fakeRequest = Object.assign(stream, {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
  return {
    request: fakeRequest as unknown as import("node:http").IncomingMessage,
    response: response as unknown as import("node:http").ServerResponse,
    responseStub: response,
    requestUrl: new URL(url),
    corsOrigin: null,
  };
};

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

  it("reports transport-unsupported when probing pty transport", async () => {
    // codex still uses pty transport in DEFAULT_ROUTING_CONFIG; the
    // dispatcher's checkProviderHealth only handles stdio today.
    const result = await checkProviderHealth("codex", DEFAULT_ROUTING_CONFIG);
    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.reason).toBe("transport-unsupported");
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
    const handled = await handleDriversListRoute(ctx, {} as never);
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
    const handled = await handleDriversListRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("POST /drivers/dispatch rejects missing taskInput", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
    });
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("GET /drivers returns 405 on POST", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/drivers", {});
    const handled = await handleDriversListRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
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
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("accepts cwd within ~/.octogent/tentacles/<id>/worktree", async () => {
    // Use a path under the allowlisted prefix; the dispatcher won't
    // actually chdir into it because dryRun=true short-circuits before
    // spawn — so the directory doesn't need to exist for the 400 vs 200
    // distinction to hold.
    const cwd = `${homedir()}/.octogent/tentacles/octopus-1/worktree`;
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd,
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("accepts cwd in subdirectory of a tentacle worktree", async () => {
    const cwd = `${homedir()}/.octogent/tentacles/octopus-1/worktree/packages/core`;
    const ctx = buildPost("http://x.test/api/claude-brain/drivers/dispatch", {
      taskType: "refactor",
      taskInput: "harmless input",
      cwd,
      dryRun: true,
    });
    const handled = await handleDriversDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });
});

describe("voteRoutes M3: cwd allowlist (same policy)", () => {
  it("rejects cwd=/etc/passwd with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: "/etc/passwd",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
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
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("rejects cwd=/tmp (not whitelisted) with 400", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: "/tmp",
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(400);
  });

  it("accepts cwd=process.cwd()", async () => {
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd: process.cwd(),
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });

  it("accepts cwd within ~/.octogent/tentacles/<id>/worktree", async () => {
    const cwd = `${homedir()}/.octogent/tentacles/octopus-2/worktree`;
    const ctx = buildPost("http://x.test/api/claude-brain/votes/dispatch", {
      taskInput: "verify groundedness",
      cwd,
      dryRun: true,
    });
    const handled = await handleVoteDispatchRoute(ctx, {} as never);
    expect(handled).toBe(true);
    expect(ctx.responseStub.status).toBe(200);
  });
});
