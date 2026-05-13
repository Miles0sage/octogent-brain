# Handoff to codex — argued.dev v0.3

**Date:** 2026-05-12
**Branch:** `feat/v0.3-argued-dev` (12 commits ahead of `main`)
**Status:** Day 1+2+3-partial shipped. ~35 tests green. Branch clean. Day 6+7 blocked on domain.

## TL;DR

You are picking up the v0.3 sprint mid-flight. argued.dev = paste a public GitHub PR → 4 AI CLIs vote independently with a Darwin-corpus prior → verdict-gate catches rubber-stamps → result page is shareable. Tagline locked: **"Four agents argued. One was lying."** Spec + plan + brand vote already in. You finish Days 3.4 → 7 and ship two security patches.

## What's done (don't redo)

| Layer | Status | Source of truth |
|---|---|---|
| Spec | locked | `/root/claude-brain/docs/superpowers/specs/2026-05-12-octogent-argue-design.md` |
| Plan (2523 lines, all code embedded) | locked | `/root/claude-brain/docs/superpowers/plans/2026-05-12-argued-dev.md` |
| Brand: `argued.dev` | locked via agency-swarm vote 3-1-1 | spec |
| `apps/argue-api` Bun server + bun:sqlite | shipped Day 1 | `apps/argue-api/` |
| `packages/pr-fetcher` octokit wrapper | shipped Day 1 | `packages/pr-fetcher/` |
| `packages/oracle` sqlite-vec lookup + ingest | shipped Day 2 | `packages/oracle/` |
| Corpus ingested: 12 unique clusters | populated | `apps/argue-api/db/argued.sqlite` |
| `validateVerdict` citation gate (`@octogent/core`) | shipped Day 3.1 | `packages/core/src/verdict-gate.ts` |
| `argue()` 4-CLI fan-out (`@octogent/supervisor`) | shipped Day 3.2 | `packages/supervisor/src/argue.ts` |
| 4 real CLI dispatchers (aider, claude-code, codex, gemini-cli) | shipped Day 3.3 | `packages/supervisor/src/dispatchers/` |
| codex audit P1 — GET `/api/claude-brain/drivers` gated | shipped same session | commit `24c58c3` |

## What's next (in order)

### 1. Day 3 Task 3.4 — Pipeline orchestrator (3-4 hrs)
File: `apps/argue-api/src/pipeline.ts` (NEW)
Behavior: `runPipeline(id, db, deps)` reads queued row → fetch PR if needed → oracle.lookup(diff) → supervisor.argue() → validateVerdict each → persist verdicts with gate_pass + GATE_FAILED on rubber-stamps. Wire into POST /argue as fire-and-forget after 202 response.

Plan has the full TDD code in section "Task 3.4: Pipeline orchestrator". Mocked deps in tests. Public entry from supervisor: `dispatchAll(cli, input)`.

### 2. Day 3 acceptance smoke (30 min)
Run the full stack against one real public PR. Verify 4 verdicts persist, at least 1 GATE_FAILED if any CLI returns naked verdict. This is where you discover whether each CLI binary actually answers (claude/codex use logged-in auth, gemini uses `GEMINI_API_KEY`, aider uses `--model gemini/gemini-2.0-flash-exp` which also reads `GEMINI_API_KEY`).

### 3. Day 4 — Result page SSR (5 hrs, pure code)
Tasks 4.1 (GET /v/:id API) + 4.2 (Next.js 15 scaffold) + 4.3 (Result page). Plan has all code.

### 4. Day 5 — Landing + reveal + Playwright (6 hrs)
Tasks 5.1 (landing with lived-experience opener — need 2026-04-23 `rm -rf node_modules/*` screenshot) + 5.2 (reveal animation) + 5.3 (Playwright headless smoke — `apt install` browser deps as root).

### 5. Day 6 — BLOCKED until Day 0 prereqs
Need: argued.dev domain registered, DNS A record → 152.53.55.207, root@152.53.55.207 ssh access. Then Caddy + systemd + 10 Famous Fights seed.

### 6. Day 7 — BLOCKED until Turnstile keys
Need: Cloudflare Turnstile site key + secret for argued.dev. Then rate limit + OG image + launch tweet.

### 7. codex security audit P2 + P3 (half day combined, can run parallel with Day 4-5)

**P2 — WS auth = Origin/Host only:**
- Current: `apps/api/src/createApiServer/upgradeHandler.ts` checks Origin/Host but no bearer.
- Frontend builds `/api/terminals/<id>/ws` with NO token (see `apps/web/src/runtime/runtimeEndpoints.ts:396`).
- Recommend: add POST `/api/auth/session` that exchanges Bearer → short-lived signed ticket, set as HttpOnly cookie. WS upgrade handler reads cookie + verifies signature OR check ticket against an in-memory expiring map. ~4 hrs.

**P3 — Proxy trust unencoded:**
- Current: `security.ts:isLoopbackRemoteAddress(request.socket.remoteAddress)`.
- Behind reverse proxy, `socket.remoteAddress` is proxy IP → loopback fallback wrongly passes everything.
- Recommend: add `OCTOGENT_TRUST_PROXY` env var. When `1`, parse `X-Forwarded-For` first IP (leftmost) and use that as remote address. When unset, behavior unchanged. Document explicitly in `security.ts` header comment. ~3 hrs.

## Architecture decisions — DO NOT relitigate

These were already debated + locked. Reverting them costs a refactor cycle (already happened twice this sprint).

1. **DB driver: `bun:sqlite`**, not better-sqlite3 (native binding broken in Bun), not @libsql/client (async, refuses sqlite-vec extension). sqlite-vec is load-bearing — its compat dictates the driver.
2. **One driver across packages** — argue-api + oracle both use bun:sqlite. Two drivers = pipeline pain. Don't split.
3. **Embedding: `gemini-embedding-001 @ 768d`** — already calibrated. L2-normalize after Matryoshka truncation.
4. **Env: `GOOGLE_API_KEY ?? GEMINI_API_KEY`** — code accepts both. GEMINI_API_KEY is what's exported on this host.
5. **CLI dispatchers use injectable `runner`** — for testability without subprocess spawns. Live runner = `runProcess` from `spawn-helper.ts`. Mock runner = `vi.fn().mockResolvedValue(...)`.
6. **Citation enforcement** — every issue MUST include `diff_lines: [start, end]` or `darwin_pattern_id: string`. Naked APPROVE/REJECT = `gate_pass: false`, decision rewritten to `GATE_FAILED` in pipeline.
7. ~~**2k token diff cap** — `truncateDiff()` caps at 8000 chars + appends `[diff continues - truncated at 2k tokens]`.~~ **OVERRIDDEN 2026-05-13 by Amendment A1** (NotebookLM review): per-CLI diff strategy. claude-code + codex see full diff; aider + gemini-cli see structural summary via `prepareCliDiff()` in `packages/supervisor/src/diff-strategy.ts`. Pipeline now stores full diff. See spec `## Amendments — 2026-05-13` section for the full diff.
8. **Argument ID format** — nanoid Crockford alphabet, length 12, regex `/^[a-z0-9]{12}$/`.

## Corpus reality check (matters for launch narrative)

Plan assumed 800 unique clusters. Actual: **12** from 15 daily files in `/root/claude-brain/dpo-pairs/*.jsonl`. Filter chain (auth_error class dropped, desc ≥ 30 chars) collapses 559 raw → 70 filtered → 12 unique. Two options before launch:

- (a) Widen the filter: keep `auth_error` clusters that have non-trivial descriptions. They are real signal (rotated keys, expired tokens). Easy win, ~30 min.
- (b) Seed with synthetic clusters drawn from public failure databases (CVE summaries, SO post titles). Could 10x the corpus. ~2 hrs.

Pick (a) for v0.3. (b) for v0.3.1.

## p95 budget caveat

Day-2 acceptance was "<500 ms p95 oracle lookup." Measured 776 ms in benchmark. 100% of that is Gemini embed network call — sqlite-vec query itself is sub-ms. Two paths:

- Accept for v0.3. Document in result page as "first lookup ~1s, instant after cache."
- Add a `pr_sha → embed` cache table. Hits skip the embed call entirely. ~1 hr.

Recommend cache for v0.3 — it directly improves Famous Fights gallery latency too.

## Files to read first (in this exact order)

1. `apps/argue-api/src/db.ts` — DB shape and bun:sqlite usage
2. `packages/supervisor/src/argue.ts` — types: `ArgueInput`, `RawVerdict`, `IssueCitation`
3. `packages/supervisor/src/dispatchers/index.ts` — `dispatchAll(cli, input)` is THE public entry
4. `packages/oracle/src/index.ts` — `createOracle(db, opts).lookup(diff)`
5. `packages/core/src/verdict-gate.ts` — `validateVerdict({decision, issues, reasoning}) → {ok, status?, reason?}` actually returns `{gate_pass, reason}` for this purpose; verify exact shape before integrating
6. `apps/argue-api/src/routes/argue.post.ts` — handler shape to mirror for pipeline
7. `apps/api/src/createApiServer/security.ts` — `checkAuthorizedRequest` returns `AuthOutcome = {ok: true} | {ok: false; status; reason}` — use this in any new gate

## Test runner pattern

```bash
cd /root/octogent-brain/apps/argue-api && /root/.bun/bin/bun --bun x vitest run
cd /root/octogent-brain/packages/oracle && /root/.bun/bin/bun --bun x vitest run
cd /root/octogent-brain/packages/supervisor && /root/.bun/bin/bun --bun x vitest run
cd /root/octogent-brain/packages/core && /root/.bun/bin/bun --bun x vitest run
```

`bun --bun x` is required for `bun:sqlite` access under vitest. Plain `bunx vitest` falls back to Node and bun:sqlite fails.

There is a pre-existing failure in `packages/supervisor/tests/watcher.test.ts` due to `@octogent/core` dist not being built. Unrelated to this sprint. Either `pnpm -r build` first or accept it as flaky.

## Risks I'm flagging

- **CLI dispatchers untested live.** Mocked tests pass. Real invocations may fail on: auth (`claude` needs login, `codex` needs ChatGPT login, gemini needs key, aider needs gemini-flash key), timeout (120s cap per CLI), output parsing (each CLI's stdout shape varies, JSON extraction regex may miss). Run the Day-3 smoke before claiming Day 3 done.
- **Cost.** 4 CLIs × per-PR cost = real money. Cache by PR sha is essential before launch.
- **Famous Fights gallery (Day 6 Task 6.3)** needs 10 curated PR URLs that produce real 4-CLI disagreement. Manual selection. Don't pick PRs that are too small (boring agreement) or too large (CLIs time out).
- **Domain availability still unverified.** `argued.com` may be a Wikipedia-citations startup per bd-reviewer's prior. USPTO TESS check is mandatory before launch tweet.

## Commit style

Conventional commits, no AI attribution, no gpg sign (`git -c commit.gpgsign=false commit`). Subjects map to plan task ID: `feat(<pkg>): <what> (Task N.M)` or `fix(...)` for security audit.

## Pickup command

```bash
cd /root/octogent-brain
git checkout feat/v0.3-argued-dev
git pull origin feat/v0.3-argued-dev  # if pushed
cat docs/HANDOFF-2026-05-12-CODEX.md  # this file
cat /root/claude-brain/docs/superpowers/plans/2026-05-12-argued-dev.md | head -200
```

Then start at "Day 3 Task 3.4 — Pipeline orchestrator."
