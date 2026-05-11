export type AgentRuntimeState =
  | "idle"
  | "processing"
  | "waiting_for_permission"
  | "waiting_for_user";

export const isAgentRuntimeState = (value: unknown): value is AgentRuntimeState =>
  value === "idle" ||
  value === "processing" ||
  value === "waiting_for_permission" ||
  value === "waiting_for_user";

// Cross-vendor CLI providers. Adding new ones is additive — existing
// "claude-code" + "codex" stay first-class. New providers default to a
// stdio-spawn driver; the Driver interface lives in ./driver.ts and a
// routing.json file maps task-type -> preferred provider for the
// Generator-Evaluator loop. See research/2026-05-11 NotebookLM
// synthesis for the cross-CLI-thesis rationale.
export type TerminalAgentProvider =
  | "codex"
  | "claude-code"
  | "aider"
  | "gemini-cli";

export const TERMINAL_AGENT_PROVIDERS: TerminalAgentProvider[] = [
  "codex",
  "claude-code",
  "aider",
  "gemini-cli",
];

export const isTerminalAgentProvider = (value: unknown): value is TerminalAgentProvider =>
  typeof value === "string" && TERMINAL_AGENT_PROVIDERS.includes(value as TerminalAgentProvider);
