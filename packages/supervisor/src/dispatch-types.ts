import type { TerminalAgentProvider } from "@octogent/core";

// Result of a driver dispatch. The dispatcher returns this synchronously
// after spawning the subprocess; output streams in via the events list.
export type DriverHealthStatus =
  | { healthy: true }
  | { healthy: false; reason: "binary-missing"; binary: string }
  | { healthy: false; reason: "env-missing"; missing: ReadonlyArray<string> }
  | { healthy: false; reason: "transport-unsupported"; transport: string }
  | { healthy: false; reason: "no-driver-for-task"; taskType: string };

export type DriverInvocation = {
  provider: TerminalAgentProvider;
  command: string;
  args: ReadonlyArray<string>;
  cwd: string;
  envFlags: ReadonlyArray<string>;
};

export type DriverDispatchEvent =
  | { kind: "stdout"; data: string }
  | { kind: "stderr"; data: string }
  | { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
  | { kind: "error"; message: string };

export type DriverDispatchResult = {
  dispatch_id: string;
  taskType: string;
  invocation: DriverInvocation | null;
  health: DriverHealthStatus;
  started_at_iso: string;
  events: ReadonlyArray<DriverDispatchEvent>;
  exit_code: number | null;
  duration_ms: number | null;
};
