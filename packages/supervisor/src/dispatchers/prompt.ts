import type { ArgueInput } from "../argue";

export function buildArguePrompt(input: ArgueInput): string {
  const priorsBlock = input.darwin_priors.length === 0
    ? "  (no similar past failures above similarity threshold)"
    : input.darwin_priors.map((p) =>
        `  - ${p.cluster_id}: ${p.description} (seen ${p.n_observations}× before)`
      ).join("\n");

  return [
    "You are a senior code reviewer voting on a public GitHub PR.",
    "",
    "## Context",
    `PR description: ${input.description || "(none)"}`,
    `CI status: ${input.ciStatus}`,
    "",
    "## Darwin priors (similar past failures from a public agent-failure corpus)",
    priorsBlock,
    "",
    "## Diff (may be truncated)",
    "```diff",
    input.diff,
    "```",
    "",
    "## Output",
    "Return ONLY a JSON object on a single line matching this schema:",
    `{"decision":"APPROVE"|"REJECT","issues":[{"severity":"info"|"low"|"medium"|"high"|"critical","message":"...","diff_lines":[start,end] OR "darwin_pattern_id":"errcls_..."}],"reasoning":"max 200 words"}`,
    "",
    "REQUIRED: every issue MUST include either `diff_lines` OR `darwin_pattern_id`. A naked verdict will be rejected by the gate as a rubber-stamp. Output JSON only, no prose, no markdown fence.",
  ].join("\n");
}
