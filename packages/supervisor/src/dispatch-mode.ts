// dispatch-mode.ts — selects which CLIs argue.ts fans out to.
//
// Three modes, lifted from arena-workflow's cost-control taxonomy and
// re-purposed for argued.dev's adversarial-review pattern:
//
//   competitive (default) — all 4 CLIs vote. Highest signal, highest cost.
//   focused               — claude-code + 1 specialist picked from the
//                           top Darwin prior's failure class. 2 verdicts,
//                           50% cost, ~80% of the consensus information.
//   quick                 — claude-code only. 1 verdict, 25% cost. Useful
//                           for doc-only / dependency-bump PRs where the
//                           gate's anti-rubber-stamp is the only point.

import type { CliName, Prior } from "./argue";
import { CLIS } from "./argue";

export type DispatchMode = "competitive" | "focused" | "quick";

const KNOWN_MODES: readonly DispatchMode[] = ["competitive", "focused", "quick"];

export function parseDispatchMode(raw: string | undefined): DispatchMode {
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed) return "competitive";
  if ((KNOWN_MODES as readonly string[]).includes(trimmed)) {
    return trimmed as DispatchMode;
  }
  return "competitive";
}

const SECURITY_KEYWORDS = /\b(security|injection|auth|secret|crypto|xss|csrf|rce)\b/i;
const UI_KEYWORDS = /\b(ui|ux|css|a11y|accessibility|design|visual|component|button|focus)\b/i;
const REFACTOR_KEYWORDS = /\b(refactor|rename|move|extract|inline|migrate|signature)\b/i;

function classifyTopPrior(priors: Prior[]): CliName {
  const top = priors[0];
  if (!top) return "codex";
  const text = `${top.cluster_id} ${top.description}`;
  if (SECURITY_KEYWORDS.test(text)) return "codex";
  if (UI_KEYWORDS.test(text)) return "gemini-cli";
  if (REFACTOR_KEYWORDS.test(text)) return "aider";
  return "codex";
}

export function pickClisForMode(
  mode: DispatchMode,
  priors: Prior[]
): readonly CliName[] {
  if (mode === "quick") return ["claude-code"];
  if (mode === "focused") {
    const specialist = classifyTopPrior(priors);
    if (specialist === "claude-code") return ["claude-code", "codex"];
    return ["claude-code", specialist];
  }
  return CLIS;
}
