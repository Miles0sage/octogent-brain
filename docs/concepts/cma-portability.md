# CMA Rubric Portability (v0.2)

Octogent adopts Anthropic's published outcome-grader schema as the
`@octogent/supervisor` voter input contract. Paste a rubric that
Anthropic ships in `claude-cookbooks`, and the cross-vendor vote route
will grade the same rubric across Claude, Codex, and Gemini, then vote
mechanically on the outcome.

## What it is

`CmaRubric` mirrors the shape used in
`anthropics/claude-cookbooks/managed_agents/CMA_verify_with_outcome_grader.ipynb`
(cookbook PR #599, 2026-05-06). Each rubric carries:

- `rubric_id` + `rubric_version` — stable identifiers
- `criteria[]` — `{ name, description, weight }` per criterion
- `passing_threshold` — weighted-average gate in `[0, 1]`

`CmaGradeResult` is the per-vendor response shape: `criterion_scores`,
`weighted_average`, `passed`, `rationale`. The schema is stable; we do
not extend it without a major-version bump.

## Why

Anthropic shipped the horizontal verifier reference architecture in the
cookbook. We adopt their schema and route it across three vendors they
structurally cannot reach — Claude API revenue would be cannibalized
the moment Anthropic shipped cross-vendor routing themselves. We use
their pattern, their JSON contract, their rubric format. There is
nothing to object to. We are orthogonal: Managed Agents is single-vendor
runtime; Octogent is the cross-vendor verifier mux on top.

## How

`POST /api/claude-brain/votes/dispatch` accepts an optional `rubric`
field. When present, the voter loop:

1. Validates the rubric shape via `isCmaRubric` from `@octogent/core`.
   Bad shape returns HTTP 400 before any subprocess spawn.
2. Prepends `buildCmaPromptInjection(rubric)` to each voter's
   `taskInput` before fan-out. The injection asks the LLM to grade
   against the rubric and emit a `CmaGradeResult` JSON tail.
3. After each voter completes, scans stdout with
   `parseCmaGradeFromText`. A parseable grade is adapted via
   `cmaGradeToReviewerVerdict(grade, rubric)` (mapping `weighted_average
   -> groundedness`, `1 - variance(scores) -> specificity`, `passed
   -> verdict`).
4. If no grade is parseable, the existing `parseReviewerVerdict` path
   handles the response. The voter is never failed for an unparseable
   tail — `tallyVotes` treats null verdicts as unparseable per its
   existing contract.

The order of checks in the route is preserved: C1 auth -> cost-cap
pre-flight -> rubric injection per voter -> spawn -> parse -> tally ->
`recordSpend`. Auth and cost caps fire before any rubric work. Without
a `rubric` field the route is byte-for-byte backward compatible.

## Example

```bash
curl -X POST http://localhost:8787/api/claude-brain/votes/dispatch \
  -H "Content-Type: application/json" \
  -d '{
    "taskInput": "Does this diff cite the source files it touches?",
    "taskType": "verify",
    "providers": ["claude-code", "codex", "gemini-cli"],
    "rubric": {
      "rubric_id": "anthropic-cookbook-outcome-grader",
      "rubric_version": "1.0.0",
      "criteria": [
        { "name": "grounded",  "description": "Cites source files", "weight": 0.6 },
        { "name": "concrete",  "description": "Uses concrete numbers", "weight": 0.4 }
      ],
      "passing_threshold": 0.8
    }
  }'
```

The response envelope is the same as the unrubricated vote:

```json
{
  "vote_id": "…",
  "outcome": {
    "winner": "pass" | "fail" | "no-consensus",
    "reason": "…",
    "consensus_count": 2,
    "dissent_count": 1,
    "verdicts": [
      {
        "provider": "claude-code",
        "verdict": {
          "verdict": "pass",
          "issues": [],
          "scores": { "groundedness": 0.92, "specificity": 0.88 },
          "improvements_exhausted": false
        },
        "raw_output": "…full vendor stdout incl. the CmaGradeResult JSON tail…"
      }
    ]
  },
  "dispatch_ids": ["…"],
  "started_at_iso": "…",
  "duration_ms": 421
}
```

## Spec

The locked design contract lives at
[`docs/superpowers/specs/2026-05-12-cma-rubric-portability.md`](../superpowers/specs/2026-05-12-cma-rubric-portability.md).
The wave-1 types + adapter shipped in commit `6a1ff11`; wave-1b wired
the route in this release.
