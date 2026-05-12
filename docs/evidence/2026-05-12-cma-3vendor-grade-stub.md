# CMA 3-vendor grade evidence (stub)

**Status:** stub — schema and adapter shipped 2026-05-12 (v0.2 wave 1).
A live 3-vendor invocation is queued for after the v0.1 npm publish
(needs `NPM_TOKEN` configured + at least one downstream consumer to
exercise the new prompt-injection path end-to-end).

## What this file will contain once promoted

A reproducible run that:

1. Loads a real Anthropic `CMA` rubric (the outcome-grader default from
   `anthropics/claude-cookbooks/managed_agents/CMA_verify_with_outcome_grader.ipynb`).
2. Dispatches the same task to `claude-code`, `codex`, and `gemini-cli` via
   `@octogent/supervisor`'s dispatcher.
3. Injects the rubric via `buildCmaPromptInjection(rubric)` as a system
   prefix to each voter prompt.
4. Parses each voter's tail JSON via `parseCmaGradeFromText`.
5. Adapts each `CmaGradeResult` via `cmaGradeToReviewerVerdict(grade, rubric)`.
6. Runs `tallyVotes` across the three adapted verdicts.
7. Captures (a) raw stdout from each vendor, (b) the parsed grade, (c) the
   adapted `ReviewerVerdict`, (d) the final `VoteOutcome`.

## Example rubric (reverse-engineered shape, illustrative)

```ts
const rubric: CmaRubric = {
  rubric_id: "outcome-grader-default",
  rubric_version: "1.0.0",
  criteria: [
    { name: "correctness", description: "Solves the stated task with no regressions", weight: 0.5 },
    { name: "groundedness", description: "Every claim cites a concrete file/line", weight: 0.3 },
    { name: "specificity", description: "No hedging; commits to numbers", weight: 0.2 },
  ],
  passing_threshold: 0.7,
};
```

## Wiring (already on disk — wave 1)

- `@octogent/core` → `CmaRubric`, `CmaGradeResult`, `isCmaRubric`,
  `isCmaGradeResult`, `parseCmaGradeFromText` (see
  `packages/core/src/domain/cma-rubric.ts`).
- `@octogent/supervisor` → `cmaGradeToReviewerVerdict`,
  `buildCmaPromptInjection` (see `packages/supervisor/src/cma-adapter.ts`).

## Wiring (still TODO — wave 1b)

- `apps/api/src/createApiServer/voteRoutes.ts` accepts an optional
  `rubric: CmaRubric` field on `POST /api/claude-brain/votes/dispatch`.
  When present, the dispatcher prefixes each voter prompt with
  `buildCmaPromptInjection(rubric)` and runs each response through
  `parseCmaGradeFromText` + `cmaGradeToReviewerVerdict` before
  `tallyVotes`. When absent, falls back to the current free-form
  `ReviewerVerdict` tail (no breaking change).

## Promotion criteria

This stub is promoted to a real evidence run when:

- (a) `NPM_TOKEN` is configured and `@octogent/supervisor@0.1.0` is on the
  npm registry,
- (b) wave 1b ships the `voteRoutes.ts` rubric-injection plumbing, and
- (c) a real run captures three vendor outputs against a real Anthropic
  rubric in this file.

Until then, the schema + adapter are unit-tested at the type level (see
`packages/core/tests/cmaRubric.test.ts` and
`packages/supervisor/tests/cmaAdapter.test.ts`).
