import type { RawVerdict, IssueCitation } from "../argue";

export type ExtractResult =
  | {
      ok: true;
      verdict: Omit<RawVerdict, "cli" | "cost_usd" | "duration_ms">;
    }
  | {
      ok: false;
      error: string;
    };

const FENCE_RE = /```(?:json)?\s*\n([\s\S]*?)\n```/;
const RAW_JSON_RE = /\{[\s\S]*"decision"[\s\S]*\}/;

export function extractJsonVerdict(stdout: string): ExtractResult {
  let candidate = stdout.trim();
  const fenceMatch = FENCE_RE.exec(candidate);
  if (fenceMatch) candidate = fenceMatch[1].trim();
  else {
    const rawMatch = RAW_JSON_RE.exec(candidate);
    if (rawMatch) candidate = rawMatch[0];
  }
  if (!candidate) return { ok: false, error: "empty output" };
  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message.slice(0, 100)}` };
  }
  if (parsed.decision !== "APPROVE" && parsed.decision !== "REJECT") {
    return { ok: false, error: `invalid decision: ${parsed.decision}` };
  }
  if (!Array.isArray(parsed.issues)) {
    return { ok: false, error: "issues must be array" };
  }
  const issues: IssueCitation[] = parsed.issues.map((i: any) => ({
    severity: String(i.severity ?? "info"),
    message: String(i.message ?? ""),
    diff_lines:
      Array.isArray(i.diff_lines) && i.diff_lines.length === 2
        ? ([Number(i.diff_lines[0]), Number(i.diff_lines[1])] as [number, number])
        : undefined,
    darwin_pattern_id:
      typeof i.darwin_pattern_id === "string" ? i.darwin_pattern_id : undefined,
  }));
  return {
    ok: true,
    verdict: {
      decision: parsed.decision as "APPROVE" | "REJECT",
      issues,
      reasoning: String(parsed.reasoning ?? "").slice(0, 2000),
    },
  };
}
