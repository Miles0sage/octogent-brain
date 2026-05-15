# Contributing

Octogent is an experimental personal project and is not actively reviewing pull requests right now. If you still open one, keep changes small, test-backed, and easy to review.

## Before you change anything

- read the relevant docs in `docs/`
- check whether the behavior already exists in the API or UI before adding more surface area
- keep the project Claude Code-first in docs and product framing
- do not document speculative features as if they already work

## Prerequisites

- Node.js `22+`
- pnpm
- `claude` for the supported agent workflow
- `git` for worktree features

## Setup

```bash
pnpm install
```

## Development

```bash
pnpm dev
```

The dev runner starts the local API and web app together.

## Required checks

Run these before opening a pull request:

```bash
pnpm test
pnpm lint
pnpm build
```

Use `pnpm format` if you need to rewrite formatting.

## Release gate (manual)

Before tagging a release, run the seeded real-PR smoke against an installed
set of CLI binaries (`/usr/bin/{aider,codex,gemini,claude}` by default) and
have the release-gate evaluator decide if the pipeline plumbing held:

```bash
mkdir -p /tmp/argued-gate
ARGUED_SMOKE_ARTIFACT_DIR=/tmp/argued-gate \
  pnpm --filter @octogent/argue-api release:gate
```

What the gate checks:

- Pipeline `status` reached `"done"` (no server-side crash)
- All 4 CLIs produced verdict rows (`aider`, `claude-code`, `codex`, `gemini-cli`)
- A `consensus` value was written (`APPROVE`, `REJECT`, `SPLIT`, or `INCOMPLETE`)

What the gate explicitly does NOT fail on:

- `INCOMPLETE` consensus from vendor-degraded runs — that is an honest
  outcome that the vendor-degraded banner already surfaces. Use the banner
  + `vendorDegraded` in the artifact JSON to triage which CLI was down.

Artifacts retained at `ARGUED_SMOKE_ARTIFACT_DIR`:

- `result.json` — full smoke output (PR URL, wall ms, summary, verdicts)
- `argued.sqlite` — the in-memory smoke DB copied out for offline replay

The same gate can be wired into a GitHub Actions `workflow_dispatch` step
on a self-hosted runner that has the four CLI binaries installed; the
default `ubuntu-latest` runner does not ship them, and the gate will
fail-open in a way that defeats its purpose if every CLI returns a
transport failure, so do not wire it to stock CI without a real CLI
environment.

Customisation knobs:

- `ARGUED_SMOKE_PR_URL` — override the default openai/openai-node#1837 fixture
- `ARGUED_SMOKE_TIMEOUT_MS` (default `300000`) — bound the whole gate run
- `CODEX_MAX_ATTEMPTS` / `CODEX_RETRY_BUDGET_MS` — see `packages/supervisor/src/dispatchers/retry-policy.ts`

## What good contributions look like

- incremental changes with clear scope
- tests for behavior changes
- docs updated in the same change when workflows or concepts change
- code and docs that reflect the current implementation, not a roadmap

## Docs policy

- `docs/` is for contributor and future-agent understanding
- if you change tentacles, todos, terminals, orchestration, or messaging, update the matching docs page

## Pull request expectations

- understand that pull requests are not actively reviewed right now
- explain the problem in one short paragraph
- explain the behavior change in concrete terms
- mention any persistence, API, or workflow impact
- include screenshots for visible UI changes
- disclose which coding agent and model were used if any code was written with AI
- call out missing follow-up work explicitly instead of hiding it

## Areas that matter most right now

- tentacle model and agent-facing context files
- todo parsing and delegation flow
- Claude Code terminal lifecycle
- child-agent orchestration
- inter-agent messaging
- fixing existing issues and optimize for reliability
