# Methodology: why 4 CLIs argue, not 1

argued.dev's review pipeline runs **four AI CLIs in parallel** (aider, claude-code, codex, gemini-cli) against the same PR, collects structured verdicts, and gates them against a rubber-stamp filter. This document explains why a multi-CLI argument is more useful than a single best-CLI verdict.

## Premise: no single CLI dominates code review

Public benchmarks as of March 2026 show every leading code-review model winning on different axes. Routing all reviews to one CLI throws away the others' coverage.

| Capability | Leader | Evidence |
|---|---|---|
| General coding (SWE-bench Verified) | **claude-code (Opus 4.6)** — 80.8% | [SWE-bench leaderboard](https://www.marc0.dev/en/leaderboard) |
| General coding (SWE-bench Verified) | codex (GPT-5.3-Codex) — 80.0% | [SWE-bench leaderboard](https://www.marc0.dev/en/leaderboard) |
| General coding (SWE-bench Verified) | gemini-cli (Gemini 3.1 Pro) — 80.6% | [SWE-bench leaderboard](https://www.marc0.dev/en/leaderboard) |
| Autonomous execution (Terminal-Bench 2.0) | **codex** — 77.3% | [SmartScope LLM Benchmark](https://smartscope.blog/en/generative-ai/chatgpt/llm-coding-benchmark-comparison-2026/) |
| Visual / UI appeal (WebDev Arena) | **gemini-cli** — 1487 ELO | WebDev Arena leaderboard |
| Code review quality | **claude-code** — tied #1 with Qwen | [Milvus AI Code Review](https://milvus.io/blog/ai-code-review-gets-better-when-models-debate) |
| Edge-case + security catch rate | **codex** — developer-reported | [Render AI Coding Agents](https://render.com/blog/ai-coding-agents-benchmark) |
| Responsive / accessibility code | **claude-code** | [Index.dev Gemini vs Claude](https://www.index.dev/blog/gemini-vs-claude-for-coding) |
| Large-codebase cross-reference | **gemini-cli** — 1M token context | Gemini 3.1 Pro spec |

SWE-bench scores cluster within ~1 percentage point across the top three CLIs. The interesting differences are off the headline benchmark: codex catches edge cases claude-code misses, gemini-cli catches design-system violations codex misses, claude-code catches architectural drift gemini-cli misses. **Argued.dev runs all of them so the union of their catches is the verdict surface.**

## What this gives you that single-CLI review does not

1. **Coverage by construction.** A bug-class one CLI is weak at is statistically covered by another. argued.dev's `darwin_priors` cluster historical failures and steer specialist CLIs (codex for security, gemini-cli for UI, aider for refactor consistency) — see `packages/supervisor/prompts/<cli>/reviewer.md` for the per-CLI strengths each reviewer is told about.
2. **Honest disagreement signal.** When all four CLIs approve a change, that is a stronger signal than one CLI approving. When they split, the split itself is the diagnostic — you can see which dimension (security vs UX vs architecture) the disagreement is on.
3. **Rubber-stamp resistance.** argued.dev's verdict gate (`packages/core/src/verdict-gate.ts`) rejects any "APPROVE with no cited diff_lines or darwin_pattern_id" as a rubber-stamp. A single-CLI pipeline can be fooled by a permissive model; four-of-four passing the gate cannot.
4. **Vendor-availability defense.** When one CLI is rate-limited or quota-capped, the run reports `INCOMPLETE` with a vendor-degraded banner (`apps/argue-api/src/results.ts`) instead of silently degrading to a single reviewer's opinion. See [retry-policy.ts](../packages/supervisor/src/dispatchers/retry-policy.ts) for how that's classified.

## Cost control (dispatch modes)

Running 4 CLIs costs ~$0.20–$0.50 per PR. Three modes trade reviewers for cost:

| Mode | CLIs | Cost | Use when |
|---|---|---|---|
| `competitive` (default) | aider + claude-code + codex + gemini-cli | ~$0.30 | Production review, non-trivial diffs |
| `focused` | claude-code + 1 specialist picked from top Darwin prior | ~$0.15 | Mid-complexity PRs where the prior corpus already says what failure class to expect |
| `quick` | claude-code only | ~$0.08 | Doc-only, dependency-bump, single-line config changes — the gate's anti-rubber-stamp is the only point |

Set with `ARGUED_DISPATCH_MODE=focused` or `quick` (default: `competitive`). Implementation: `packages/supervisor/src/dispatch-mode.ts`.

## Prior art

argued.dev's multi-CLI orchestration pattern is structurally related to two prior projects we want to credit:

- **CCG-workflow** (`fengshao1227/ccg-workflow`, 5k stars before account suspension ~2026-04-08) — original Claude-orchestrator pattern with static role routing (Codex=backend, Gemini=frontend).
- **arena-workflow** (`mingrath/arena-workflow`, live fork) — re-pitched the same pattern as **competitive multi-model dispatch where ALL models compete on every task**, then weighted-evaluated winner-selection.

argued.dev inherits the security-by-design contract from both ancestors (external models cannot write files, structured outputs only) and the per-CLI role-prompt file layout. It differs on the output shape: where CCG and arena both **pick a winner**, argued.dev produces a **verdict consensus** with an explicit `INCOMPLETE` escape hatch — the system refuses to vote when any reviewer fails to reply. Different products, shared lineage. See [docs/prior-art-ccg.md](./prior-art-ccg.md) for the deeper compare.

## Sources

- [SWE-bench Leaderboard (March 2026)](https://www.marc0.dev/en/leaderboard)
- [SmartScope LLM Coding Benchmark Comparison 2026](https://smartscope.blog/en/generative-ai/chatgpt/llm-coding-benchmark-comparison-2026/)
- [Milvus AI Code Review Gets Better When Models Debate](https://milvus.io/blog/ai-code-review-gets-better-when-models-debate)
- [Index.dev — Gemini vs Claude for Coding](https://www.index.dev/blog/gemini-vs-claude-for-coding)
- [Render — AI Coding Agents Benchmark](https://render.com/blog/ai-coding-agents-benchmark)
- arena-workflow [`templates/commands/routing-guide.md`](https://github.com/mingrath/arena-workflow/blob/main/templates/commands/routing-guide.md) — citation pattern inspiration
