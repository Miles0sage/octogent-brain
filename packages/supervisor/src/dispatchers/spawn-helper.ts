import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
}

export async function runProcess(
  cmd: string,
  args: string[],
  opts: SpawnOpts = {}
): Promise<SpawnResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let timedOut = false;
    const child = spawn(cmd, args, {
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
          setTimeout(() => {
            child.kill("SIGKILL");
          }, 2_000).unref();
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
    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin?.end();
    }
  });
}
