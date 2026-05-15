import type { CliName, IssueCitation, RawVerdict } from "../argue";
import type { SpawnResult } from "./spawn-helper";

function buildFailureIssues(message: string): IssueCitation[] {
  return [{ severity: "error", message }];
}

function compactProcessDetail(value: string): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 280) return singleLine;
  return `${singleLine.slice(0, 140)} ... ${singleLine.slice(-140)}`;
}

export function buildSuccessfulVerdict(
  cli: CliName,
  verdict: Pick<RawVerdict, "decision" | "issues" | "reasoning">,
  durationMs: number
): RawVerdict {
  return {
    cli,
    decision: verdict.decision,
    issues: verdict.issues,
    reasoning: verdict.reasoning,
    cost_usd: 0,
    duration_ms: durationMs,
    state: "ok",
  };
}

export function buildParseFailureVerdict(
  cli: CliName,
  message: string,
  durationMs: number
): RawVerdict {
  return {
    cli,
    decision: null,
    issues: buildFailureIssues(message),
    reasoning: "parse failure",
    cost_usd: 0,
    duration_ms: durationMs,
    state: "parse_failed",
  };
}

export function buildTransportFailureVerdict(
  cli: CliName,
  message: string,
  durationMs: number
): RawVerdict {
  return {
    cli,
    decision: null,
    issues: buildFailureIssues(message),
    reasoning: "transport failure",
    cost_usd: 0,
    duration_ms: durationMs,
    state: "transport_failed",
  };
}

export function describeProcessFailure(prefix: string, result: SpawnResult): string {
  if (result.timedOut) {
    return `${prefix} timed out after ${result.durationMs}ms`;
  }

  const outcome = [];
  if (result.exitCode != null) {
    outcome.push(`exit ${result.exitCode}`);
  }
  if (result.signal) {
    outcome.push(`signal ${result.signal}`);
  }

  const rawDetail =
    [result.stderr.trim(), result.stdout.trim()].find((value) => value.length > 0) ?? "";
  const detail = rawDetail ? compactProcessDetail(rawDetail) : "";

  return detail && detail.length > 0
    ? `${prefix} ${outcome.join(" / ")}: ${detail}`.trim()
    : `${prefix} ${outcome.join(" / ")}`.trim();
}
