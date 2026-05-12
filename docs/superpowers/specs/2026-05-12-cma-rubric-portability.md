# v0.2 — CMA rubric portability (post-r2 pivot)

Decided 2026-05-12 from agency-swarm r2 L4. Tracked here as a v0.2 milestone for follow-up implementation.

## Why

Anthropic merged `CMA_verify_with_outcome_grader.ipynb` to `anthropics/claude-cookbooks/managed_agents/` in PR #599 (2026-05-06) — the horizontal verifier template. The round-1 prediction landed 23 days early. The pure "we invented the verifier" framing is now reference architecture on the Anthropic repo.

The v0.2 wedge: **adopt the Anthropic CMA rubric format as `@octogent/supervisor`'s input contract. Run the SAME rubric across Claude + Codex + Gemini outputs. Vote. Surface disagreement.**

We're not competing with Anthropic Managed Agents. We're routing their pattern across vendors they structurally cannot reach. They can't object — we use their schema.

## What ships

### 1. CMA rubric type in `@octogent/core`

Mirror the Anthropic outcome-grader schema as `CmaRubric` type. Reverse-engineered from `CMA_verify_with_outcome_grader.ipynb`. Compatible with any rubric Anthropic publishes downstream.

```ts
export type CmaRubric = {
  // From Anthropic cookbook CMA pattern. Stable contract; do not extend
  // without checking the upstream cookbook + a major-version bump.
  rubric_id: string;
  rubric_version: string;
  criteria: ReadonlyArray<{
    name: string;
    description: string;
    weight: number; // [0, 1]
  }>;
  passing_threshold: number; // [0, 1] — weighted average of criterion scores
};

export type CmaGradeResult = {
  criterion_scores: Record<string, number>;
  weighted_average: number;
  passed: boolean;
  rationale: string;
};
```

### 2. Rubric→verdict adapter in `@octogent/supervisor`

```ts
// Maps Anthropic's per-criterion CMA grade into our ReviewerVerdict shape.
// passed → verdict: "pass" | "fail". criterion_scores collapse via weighted
// average → scores.groundedness; criterion variance → scores.specificity.
export const cmaGradeToReviewerVerdict = (
  grade: CmaGradeResult,
  rubric: CmaRubric,
): ReviewerVerdict;
```

### 3. New voter input contract in `voteRoutes.ts`

`POST /api/claude-brain/votes/dispatch` gains an optional `rubric: CmaRubric` field. When present, the dispatcher injects the rubric into each voter's prompt as a system-level instruction, asks for a CMA grade JSON, and runs `cmaGradeToReviewerVerdict` over the response. When absent, falls back to the current free-form `ReviewerVerdict` JSON tail (no breaking change).

### 4. Demo asset: 3-vendor CMA grade run

`docs/evidence/2026-06-XX-cma-3vendor-grade.md` — load a real CMA rubric (e.g., the outcome-grader's default), dispatch the same task to Claude + Codex + Gemini, capture all 3 grades, run `tallyVotes`. Live invocation, real LLM responses, durable artifact.

### 5. Documentation

- README addition: "Cross-vendor CMA rubric grading" subsection w/ code example
- `docs/concepts/cma-portability.md` — explainer + Anthropic cookbook reference + the moat sentence
- Update `CODEX.md` v0.2 wedge section to "shipped"

## Why this beats generic cross-vendor

Adopting Anthropic's rubric format makes us VALIDATE + EXTEND their pattern, not compete with it. They can't object — we use their schema. We're orthogonal: their managed-agents = single-vendor production runtime; we = cross-vendor verifier mux on top.

## Estimated effort

- Schema + adapter in core: 1-2 hrs
- Rubric injection in voteRoutes + prompt template: 2-3 hrs
- Tests across core + supervisor + api (15-20 new tests): 2-3 hrs
- Demo evidence + docs: 2 hrs
- **Total: 8-10 hours focused. Ship in 2-3 sessions.**

## Open questions

1. Anthropic Managed Agents GA — does it include the outcome-grader as a built-in primitive, or stay a user-supplied rubric? (Watch claude-cookbooks PRs + 2.1.140+.)
2. Should we also support the LangChain `evaluators` schema for cross-runtime portability? (Risk: schema-of-schemas; defer until LangChain users actually ask.)
3. Multi-rubric voting — can one task be evaluated by 3 different rubrics simultaneously? Probably out of scope for v0.2; track for v0.3.

## Source

`research/2026-05-12-octogent-r2/lane-4-anthropic-7day-refresh.md`
