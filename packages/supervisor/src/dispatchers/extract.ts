import type { RawVerdict, IssueCitation, VerdictDecision } from "../argue";

export type ExtractResult =
  | {
      ok: true;
      verdict: Omit<RawVerdict, "cli" | "cost_usd" | "duration_ms" | "state"> & {
        decision: VerdictDecision;
      };
    }
  | {
      ok: false;
      error: string;
    };

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;

function escapeLiteralNewlinesInStrings(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;

  for (const ch of input) {
    if (inString) {
      if (escaped) {
        output += ch;
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        output += ch;
        escaped = true;
        continue;
      }
      if (ch === "\"") {
        output += ch;
        inString = false;
        continue;
      }
      if (ch === "\n") {
        output += "\\n";
        continue;
      }
      if (ch === "\r") {
        continue;
      }
      output += ch;
      continue;
    }

    output += ch;
    if (ch === "\"") {
      inString = true;
    }
  }

  return output;
}

function findBalancedDecisionObject(stdout: string): string | null {
  for (let start = 0; start < stdout.length; start++) {
    if (stdout[start] !== "{") continue;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < stdout.length; i++) {
      const ch = stdout[i]!;
      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === "{") {
        depth += 1;
        continue;
      }
      if (ch !== "}") continue;

      depth -= 1;
      if (depth === 0) {
        const candidate = stdout.slice(start, i + 1);
        if (candidate.includes("\"decision\"")) return candidate;
        break;
      }
    }
  }

  return null;
}

function mapIssues(rawIssues: unknown): IssueCitation[] | null {
  if (!Array.isArray(rawIssues)) return null;
  return rawIssues.map((issue: any) => {
    const mapped: IssueCitation = {
      severity: String(issue?.severity ?? "info"),
      message: String(issue?.message ?? ""),
    };
    if (Array.isArray(issue?.diff_lines) && issue.diff_lines.length === 2) {
      mapped.diff_lines = [
        Number(issue.diff_lines[0]),
        Number(issue.diff_lines[1]),
      ];
    }
    if (typeof issue?.darwin_pattern_id === "string") {
      mapped.darwin_pattern_id = issue.darwin_pattern_id;
    }
    return mapped;
  });
}

function parseCandidate(candidate: string): ExtractResult {
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    const repaired = escapeLiteralNewlinesInStrings(candidate);
    if (repaired !== candidate) {
      try {
        parsed = JSON.parse(repaired);
      } catch {}
    }
    if (parsed == null) {
      return {
        ok: false,
        error: `JSON parse failed: ${(error as Error).message.slice(0, 100)}`,
      };
    }
  }

  if (typeof parsed?.response === "string") {
    return extractJsonVerdict(parsed.response);
  }

  if (parsed?.decision !== "APPROVE" && parsed?.decision !== "REJECT") {
    return { ok: false, error: `invalid decision: ${parsed?.decision}` };
  }

  const issues = mapIssues(parsed?.issues);
  if (!issues) {
    return { ok: false, error: "issues must be array" };
  }

  return {
    ok: true,
    verdict: {
      decision: parsed.decision as VerdictDecision,
      issues,
      reasoning: String(parsed.reasoning ?? "").slice(0, 2000),
    },
  };
}

export function extractJsonVerdict(stdout: string): ExtractResult {
  let candidate = stdout.trim();
  if (!candidate) return { ok: false, error: "empty output" };

  const fenceMatch = FENCE_RE.exec(candidate);
  if (fenceMatch && typeof fenceMatch[1] === "string") {
    candidate = fenceMatch[1].trim();
  } else {
    candidate = findBalancedDecisionObject(candidate) ?? candidate;
  }

  if (!candidate) return { ok: false, error: "empty output" };
  return parseCandidate(candidate);
}
