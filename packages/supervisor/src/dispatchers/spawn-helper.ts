import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
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
          child.kill("SIGTERM");
        }, opts.timeoutMs)
      : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, durationMs: Date.now() - t0 });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      stderr += String(err);
      resolve({ stdout, stderr, exitCode: -1, durationMs: Date.now() - t0 });
    });
    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }
  });
}
