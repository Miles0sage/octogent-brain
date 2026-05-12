// wrapper-runner.ts — adapter for the vendored codeagent-wrapper Go binary.
//
// The wrapper unifies three vendor JSON event streams (codex, claude, gemini)
// and returns the final assistant message on stdout. octogent uses this to
// replace per-CLI argv quirks with one consistent invocation contract:
//
//   <binary> --backend <cli> - <workdir>     # task on stdin
//
// Returns the same SpawnResult shape the native dispatchers expect, so a
// caller can swap between native and wrapper modes without re-plumbing the
// retry / classifier / failure-pipeline machinery.
//
// Aider is intentionally not supported here — the wrapper only knows about
// codex / claude / gemini. The native aider dispatcher stays unchanged.

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SpawnOpts, SpawnResult } from "./spawn-helper";

export type WrapperBackend = "codex" | "claude" | "gemini";

export interface WrapperRunOpts extends SpawnOpts {
  workdir?: string;
  sessionId?: string;
  lite?: boolean;
  geminiModel?: string;
}

const PACKAGE_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const VENDOR_BIN_DIR = join(PACKAGE_ROOT, "vendor/codeagent-wrapper/bin");

function platformSlug(): string | null {
  const p = platform();
  const a = arch();
  if (p === "linux" && a === "x64") return "linux-amd64";
  if (p === "linux" && a === "arm64") return "linux-arm64";
  if (p === "darwin" && a === "x64") return "darwin-amd64";
  if (p === "darwin" && a === "arm64") return "darwin-arm64";
  return null;
}

export function resolveWrapperBinary(envOverride?: string): string | null {
  const overridden = envOverride?.trim();
  if (overridden) return overridden;
  const slug = platformSlug();
  if (!slug) return null;
  return join(VENDOR_BIN_DIR, `codeagent-wrapper-${slug}`);
}

export async function isWrapperUsable(envOverride?: string): Promise<boolean> {
  const bin = resolveWrapperBinary(envOverride);
  if (!bin) return false;
  try {
    await access(bin);
    return true;
  } catch {
    return false;
  }
}

export function buildWrapperArgs(
  backend: WrapperBackend,
  opts: WrapperRunOpts = {}
): string[] {
  const args: string[] = [];
  if (opts.lite) args.push("--lite");
  args.push("--backend", backend);
  if (backend === "gemini" && opts.geminiModel) {
    args.push("--gemini-model", opts.geminiModel);
  }
  if (opts.sessionId) args.push("resume", opts.sessionId);
  args.push("-");
  if (opts.workdir) args.push(opts.workdir);
  return args;
}

export async function runWrapper(
  backend: WrapperBackend,
  prompt: string,
  opts: WrapperRunOpts = {}
): Promise<SpawnResult> {
  const bin = resolveWrapperBinary(process.env.ARGUED_WRAPPER_BIN);
  if (!bin) {
    return {
      stdout: "",
      stderr: `wrapper-runner: no vendored binary for ${platform()}/${arch()}`,
      exitCode: 127,
      signal: null,
      timedOut: false,
      durationMs: 0,
    };
  }

  const args = buildWrapperArgs(backend, opts);
  const t0 = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d) => {
      stderr += d.toString();
    });
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
        }, opts.timeoutMs)
      : null;
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal,
        timedOut,
        durationMs: Date.now() - t0,
      });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      stderr += String(err);
      resolve({
        stdout,
        stderr,
        exitCode: -1,
        signal: null,
        timedOut,
        durationMs: Date.now() - t0,
      });
    });
    child.stdin?.write(prompt);
    child.stdin?.end();
  });
}

export interface ExtractSessionResult {
  sessionId: string | null;
  message: string;
}

const SESSION_ID_RE = /\bSESSION_ID:\s*([A-Za-z0-9_-]{6,})/;

export function extractSessionId(stdout: string): ExtractSessionResult {
  const match = SESSION_ID_RE.exec(stdout);
  if (!match) return { sessionId: null, message: stdout };
  const sessionId = match[1] ?? null;
  const message = stdout.replace(match[0], "").trim();
  return { sessionId, message };
}
