# Codex Build Pivot

This repo is two products wearing one coat.

## What It Actually Is

- `packages/core`: pure review-gate + loop logic
- `packages/supervisor`: the real wedge; publishable mechanical-supervision substrate
- `apps/api` + `apps/web`: local operator control plane and demo shell

The durable moat is not "another agent dashboard." It is a local, vendor-agnostic
trust layer that stops agents from grading their own work.

## Product Pivot

Near-term wedge:
- Sell and explain `@octogent/supervisor`
- Prove three things: safe dispatch, structured verdict gating, cross-vendor voting

Support asset:
- Keep `apps/api` + `apps/web` as the proving ground, demo surface, and operator UX
- Do not let the dashboard become the main story before the substrate is adopted

## Non-Negotiables

- Safety boundaries beat launch copy
- `cwd` policy must use configured workspace root, not ambient process state
- `cwd` policy must validate canonical real paths, not just string-clean prefixes
- No arbitrary flag injection into spawned CLIs
- No claim of "all tests pass" unless a clean checkout can prove it
- No smoke-test claims without a committed reproducer or literal captured output

## What Codex Should Do Next

1. Protect the substrate first.
Fix anything that weakens the safety or honesty contract in `packages/core`,
`packages/supervisor`, and the API routes that expose them.

2. Keep the clean-checkout story real.
`pnpm install && pnpm test` should work without tribal knowledge. If package tests
need built `dist` artifacts, make the root test path do that explicitly.

3. Prefer proofs over adjectives.
When changing launch or evidence docs, either link to a reproducer or tone the
claim down.

4. Use the dashboard as leverage, not identity.
The web app exists to demonstrate the substrate and help operate it. The wedge is
mechanical supervision, not a generic control room.

## Release Shape

Before external release, the minimum acceptable bar is:

- clean `pnpm test`
- `@octogent/core` publishable
- `@octogent/supervisor` publishable
- one reproducible live-smoke script
- one documented real-provider smoke with honest caveats on cost/auth

## Bad Direction

Do not pivot into:
- "AI OS"
- "agent platform for everything"
- hosted-cloud-first messaging before the local trust layer is adopted

That path dilutes the only sharp thing in the repo.

## Locked Launch Copy (2026-05-12 r2 agency-swarm L5)

Empirically scored 4 framings on HN Algolia + adjacent OSS evidence; D synthesis won 85/100.

- **Show HN title:** `Show HN: Octogent – 3 LLMs vote on every diff before it touches your repo`
- **Tagline:** *Three LLMs vote on every diff. Local. Free. The verifier Anthropic can't ship.*
- **12-word description:** *Aider writes. Claude reviews. Codex breaks ties. Local cross-vendor verifier loop.*

Do NOT lead with "Mechanical Supervision" — zero HN keyword surface (nbHits: 0).
Do NOT lead with "Trust Layer for AI Agents" — crowded category (AgentSign + MCP Trust Layer already there).
Do lead with cross-vendor voting + the moat sentence ("Anthropic structurally can't ship this — it requires a third party willing to route across Claude + Aider + Codex").

## L4 Pivot Note (Anthropic shipped horizontal verifier T+1 day)

Anthropic merged `CMA_verify_with_outcome_grader.ipynb` (cookbook PR #599, 2026-05-06) — a stateless grader that re-checks artifacts in a fresh context. The 30-day round-1 forecast landed 23 days early. The pure "we invented the verifier" framing is now reference architecture on the Anthropic repo.

**v0.2 wedge:** Adopt the Anthropic CMA rubric format as the supervisor's input contract. Run the SAME rubric across Claude + Codex + Gemini outputs. Vote. Surface disagreement. We're not competing with Anthropic Managed Agents — we're routing their pattern across vendors they can't reach.

Source: `research/2026-05-12-octogent-r2/lane-4-anthropic-7day-refresh.md`.
