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
