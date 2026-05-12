// End-to-end test helpers. These tests boot the REAL HTTP server bound to
// a random loopback port and fire native `fetch` requests at it. Distinct
// from the handler-level tests in tests/*.test.ts which stub
// IncomingMessage/ServerResponse — those exercise route logic in
// isolation; these exercise the boot path + the wired CORS / host / auth
// pipeline that runs in front of every handler.
//
// Zero new dependencies: native `fetch` (Node 18+, confirmed v22 in CI)
// and the existing http.Server returned by createApiServer().
//
// Port binding: we always pass port=0 to listen() and read the actual
// port from server.address(). This avoids racy fixed-port choices when
// suites run in parallel.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiServer } from "../../src/createApiServer";

export type BootedApiServer = {
  baseUrl: string;
  workspaceCwd: string;
  close: () => Promise<void>;
};

export type BootOptions = {
  // Environment variables to set for the lifetime of this server. The
  // helper snapshots prior values on boot and restores them on close so
  // tests stay isolated. Pass `null` as a value to delete the var.
  env?: Record<string, string | null>;
  // Extra options forwarded to createApiServer (rarely needed in e2e tests).
  serverOptions?: Partial<Parameters<typeof createApiServer>[0]>;
};

const setEnvSnapshot = (
  env: Record<string, string | null>,
): Record<string, string | undefined> => {
  const snapshot: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    snapshot[key] = process.env[key];
    if (value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return snapshot;
};

const restoreEnv = (snapshot: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

export const bootApiServer = async (
  options: BootOptions = {},
): Promise<BootedApiServer> => {
  const envSnapshot = setEnvSnapshot(options.env ?? {});

  const workspaceCwd = mkdtempSync(join(tmpdir(), "octogent-e2e-"));
  // gitClient is intentionally omitted — createTerminalRuntime falls
  // back to its default `git`-CLI client. None of the e2e tests touch
  // tentacle worktrees, so the default client is never invoked.
  const apiServer = createApiServer({
    workspaceCwd,
    ...(options.serverOptions ?? {}),
  });
  const address = await apiServer.start(0, "127.0.0.1");
  const baseUrl = `http://${address.host}:${address.port}`;

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await apiServer.stop();
    } finally {
      restoreEnv(envSnapshot);
      try {
        rmSync(workspaceCwd, { recursive: true, force: true });
      } catch {
        // best-effort cleanup; tests should not fail on tmp removal races
      }
    }
  };

  return { baseUrl, workspaceCwd, close };
};

// Lightweight fetch wrapper that always parses JSON and never throws on
// non-2xx. Tests assert on the returned status + body.
export type FetchedResponse<T = unknown> = {
  status: number;
  headers: Headers;
  body: T;
  bodyText: string;
};

export const httpRequest = async <T = unknown>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
): Promise<FetchedResponse<T>> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const bodyText = await response.text();
  let body: T;
  try {
    body = bodyText.length === 0 ? (undefined as T) : (JSON.parse(bodyText) as T);
  } catch {
    body = bodyText as unknown as T;
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    bodyText,
  };
};
