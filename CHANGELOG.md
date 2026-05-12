# Changelog

All notable changes to the `@octogent/core` and `@octogent/supervisor` packages
in this repository are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **P0 fix:** gate all read-only `/api/claude-brain/*` routes behind C1
  auth (closes reviewer audit). 10 handlers in `claudeBrainRoutes.ts` +
  `trajectoryRoutes.ts` (daemons, dpo-recent, memory, agent-teams,
  review-fixtures{,/:name}, review-gate, rollouts{,/:id}, rewards/recent)
  now call `checkAuthorizedRequest` after the pathname/method match.
  Loopback default + `OCTOGENT_API_KEY`-bearer contract unchanged from
  the POST routes; this fix closes the leak under
  `OCTOGENT_ALLOW_REMOTE_ACCESS=1` without an API key.

## [0.2.0] - 2026-05-12

### Added (wave 1 — types only, no api wiring yet)

- **`@octogent/core` — CMA rubric portability schema.** New
  `CmaRubric` and `CmaGradeResult` types that mirror Anthropic's
  outcome-grader shape from
  `anthropics/claude-cookbooks/managed_agents/CMA_verify_with_outcome_grader.ipynb`
  (cookbook PR #599, 2026-05-06). Ships with bounded type-guards
  (`isCmaRubric`, `isCmaGradeResult`) and a tail-JSON parser
  (`parseCmaGradeFromText`) that mirrors the `parseReviewerVerdict`
  discipline in `verdict-gate.ts` — final balanced JSON object wins,
  earlier scratch JSON is ignored.
- **`@octogent/supervisor` — CMA grade <-> ReviewerVerdict adapter.**
  `cmaGradeToReviewerVerdict(grade, rubric)` collapses per-criterion
  CMA grades into the supervisor's existing two-score
  (groundedness / specificity) verdict shape: `weighted_average ->
  groundedness`, `1 - variance(scores) -> specificity`. The adapter
  preserves `passed -> verdict` semantics and emits an `issues[]`
  entry for every criterion that scored below the rubric's
  `passing_threshold`. `buildCmaPromptInjection(rubric)` returns a
  system-prefix string that asks any voter LLM to grade against the
  rubric and emit a `CmaGradeResult` JSON tail.
- **Evidence stub:** `docs/evidence/2026-05-12-cma-3vendor-grade-stub.md`
  documents the planned 3-vendor live-grade run; promoted once
  `NPM_TOKEN` is configured and wave 1b ships the `voteRoutes.ts`
  rubric-injection plumbing.

### Added (wave 2 — cost-cap UX + audit log, Lane-3 design)

- **3-layer cost-cap engine** (`apps/api/src/cost-cap.ts`). Per-dispatch,
  per-session, and per-day USD ceilings with first-trip wins ordering.
  `loadCostCapConfig()` reads `OCTOGENT_PER_DISPATCH_USD` /
  `OCTOGENT_PER_SESSION_USD` / `OCTOGENT_PER_DAY_USD` (defaults 0.50 /
  5.00 / 20.00). `OCTOGENT_TIER` (default `free`) gates the Spend subtab.
  Public 2026-05 prices baked in as `DEFAULT_PROVIDER_RATES`:
  claude-sonnet-4 $3/$15, gpt-5-codex-mini $0.25/$2, gemini-2.5-pro
  $1.25/$10, aider local $0.
- **Pre-flight refusal gate** in `voteRoutes.ts`. The `POST
  /api/claude-brain/votes/dispatch` route estimates cost-per-provider
  + sums across the fan-out + refuses with HTTP 402 +
  `{ ok: false, capError }` when any cap would trip — before any
  subprocess spawn. `recordSpend()` fires per voter after the dispatcher
  resolves; daily totals reset at 00:00 UTC.
- **Audit log + status endpoints.** `GET /api/claude-brain/cost-cap`
  returns `{ config, usage }`. `GET /api/claude-brain/cost-cap/audit`
  returns the last 100 in-memory entries. Same writes also append to
  `OCTOGENT_AUDIT_LOG` (default `/tmp/octogent-audit.jsonl`) for
  SIEM ingestion. Events: `vote-dispatched`, `cap-fire`,
  `voter-completed`.
- **Dashboard surface.** `CostCapTile` sits to the left of the Claude
  usage rail (slate / amber / red+pulse bar states). `PreflightCostPill`
  renders next to the Run cross-vendor vote button with cost + voter
  count + daily-cap guard. The vote card flips
  `data-cap-fire="true"` when a 402 comes back, giving a persistent
  bar-color shift that reads correctly in screenshots/gifs. The
  Monitor view adds a tier-gated **Spend** subtab tailing the audit
  ring + CSV export.
- **Docs.** `docs/concepts/cost-cap.md` documents the 3-layer contract,
  tier matrix, env vars, audit-log shape, and UX surfaces. Cross-linked
  from the README's new "Cost caps + audit log (v0.2)" subsection.

### Added (wave 1b — api wiring)

- **Voter-route rubric injection.** `apps/api`'s
  `POST /api/claude-brain/votes/dispatch` now accepts an optional
  `rubric` field. When present, the rubric is validated via
  `isCmaRubric` (400 on bad shape), prepended to each voter's
  `taskInput` via `buildCmaPromptInjection(rubric)`, and each voter's
  stdout is scanned with `parseCmaGradeFromText` then adapted through
  `cmaGradeToReviewerVerdict(grade, rubric)` before `tallyVotes`. The
  C1 auth gate and the wave-2 cost-cap pre-flight refusal both fire
  BEFORE rubric work — order of checks preserved.
- **Two-stage verdict extraction.** When a rubric is supplied but the
  voter emits no parseable `CmaGradeResult`, the route falls back to
  the existing `parseReviewerVerdict` path so a vote is never failed
  for an unparseable tail (`tallyVotes` treats null verdicts as
  unparseable per its existing contract). Absent rubric =>
  byte-for-byte backward compatible.
- **Docs.** `docs/concepts/cma-portability.md` documents the schema,
  the why (adopt Anthropic's pattern, don't compete with it), and the
  curl example. README gains a "CMA rubric portability (v0.2)"
  subsection cross-linked to the concept doc + the locked spec at
  `docs/superpowers/specs/2026-05-12-cma-rubric-portability.md`.

### Deferred to v0.2.x

- **Driver-level cost-cap.** The wave-2 layer enforces caps at the
  `voteRoutes` boundary. The deeper per-driver SIGTERM enforcement
  described in
  [`docs/superpowers/specs/2026-05-12-cost-cap-design.md`](docs/superpowers/specs/2026-05-12-cost-cap-design.md)
  is still deferred — those plumb caps into the dispatcher subprocess
  lifecycle.

## [0.1.0] - 2026-05-12

Initial public release of the Mechanical Supervision substrate.

### Added

- **`@octogent/core`** — framework-agnostic domain types, the `verdict-gate`
  schema validator, and the `review-fix-loop` driver. Pure TypeScript with no
  I/O surface, so it composes cleanly into any host runtime.
- **`@octogent/supervisor`** — the orchestration layer on top of
  `@octogent/core`:
  - **Cross-CLI dispatcher** that drives four coding agents over their native
    transports: `aider` (stdio), `claude-code` (stdio), `codex` (pty), and
    `gemini-cli` (stdio).
  - **Verdict-gate** that parses reviewer JSON, enforces a strict schema, and
    catches rubber-stamp passes (a "looks good" verdict with no concrete
    `issues[]` evidence is rejected and re-iterated).
  - **Cross-vendor voting** via `tallyVotes`, with three configurable decision
    modes: `consensus`, `strong-reject`, and `qualified-majority`. Lets you
    fan out the same change to two or more vendors and only ship when they
    agree (or veto when any one strongly objects).
  - **Review-fix-loop** that re-prompts the writer with the reviewer's
    issues until the gate passes or the configured iteration cap is hit.
- **Test suite** — 86 tests across `@octogent/core` and `@octogent/supervisor`
  covering schema validation, voting tallies, dispatcher framing, and the
  end-to-end review-fix loop.
- **License** — both packages ship under the MIT license, matching the parent
  repository.

### Fixed

- **L3 audit fixes** — pre-v0.1.0 stabilization sweep covering verdict-gate
  edge cases (empty `issues[]`, malformed JSON, schema-violating reviewer
  payloads) and dispatcher framing for the four CLI transports.
- **Codex-2 audit fixes** — second-pass review of dispatcher I/O,
  cross-vendor voting tie-breaks, and review-fix-loop termination conditions.

### Notes

- This is a `0.x` release, so the public TypeScript API may shift between
  minor versions until `1.0.0`.
- Cost-cap enforcement is intentionally **not** part of `v0.1.0` — see the
  `Unreleased` section above for the deferred design spec.

[Unreleased]: https://github.com/Miles0sage/octogent-brain/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miles0sage/octogent-brain/releases/tag/v0.1.0
