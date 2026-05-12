# Prior Art: CCG, arena-workflow, and argued.dev

Internal positioning. Not for the README.

## Three patterns

### 1. CCG (`fengshao1227/ccg-workflow`) — vanished

5k-star Chinese-community project, v1.7.55 -> v2.1.1. Repo and user
account wiped from GitHub early 2026; copies survive on linux.do 补档
threads. Claude = orchestrator, Codex = backend, Gemini = frontend
(static role routing). 25 `/ccg:*` slash commands. **Security**:
external models have **zero write access** — they return Unified Diff
patches via a Go `codeagent-wrapper` binary; Claude reviews and applies.
Role prompts inject via `ROLE_FILE:` header.

### 2. arena-workflow (`mingrath/arena-workflow`) — v1.8.0 live fork

Re-pitches CCG as competitive multi-model dispatch. ALL models compete
on every task in parallel (Codex + Gemini + Claude-self) — no assumed
domain owner. Weighted scoring tables per task type (analysis /
planning / impl / review / debug) cite SWE-bench Verified
(Claude 80.8%), Terminal-Bench 2.0 (Codex 77.3%), WebDev Arena
(Gemini 1487 ELO), Milvus code-review benchmark. Claude picks the
highest-scoring output, cherry-picks from losers. Modes: Competitive
(~3x cost) / Focused / Quick. **Security**: identical to CCG — diffs
only, Claude applies.

### 3. argued.dev / octogent-brain v0.3

Different problem. Same primitives. 4 CLIs (Aider + Claude Code +
Codex + Gemini-cli) run in parallel on the same **PR URL** — no
orchestrator-as-judge. Input is a PR URL, not a task. Each CLI returns
a structured verdict `APPROVE | REJECT | INCOMPLETE` + ranked issues +
reasoning trace. Consensus = single verdict with
`INCOMPLETE-if-any-failed` as rubber-stamp guard. A 12-cluster failure
corpus mined from real PR trajectories attaches matching context to
each CLI's prompt **before** it argues; a verdict-gate flags reviewers
who APPROVE despite priors predicting failure. CLIs return verdicts as
data, never apply patches.

## What overlaps

- **Patch-only security model** (CCG -> arena -> argued.dev): inherited.
- **Multi-CLI fan-out under a Claude-Code-style surface**: inherited.
- **Slash-command UX**: `/argue` echoes CCG/arena conventions.

## What's new in argued.dev

1. **Verdict shape.** `APPROVE | REJECT | INCOMPLETE` is adversarial QA
   on a PR, not "pick the winning patch." Arena synthesizes one best
   output; argued.dev surfaces disagreement and bails to INCOMPLETE when
   any CLI failed.
2. **Verdict-gate.** Each verdict is checked against Darwin priors.
   APPROVE on a PR matching a known failure pattern is downgraded with a
   flag. Neither CCG nor arena does this — they trust the highest score.
3. **Darwin priors as input, not eval.** The failure corpus is injected
   into the CLI prompt *before* arguing, biasing toward known-broken
   patterns instead of post-hoc benchmark weights.
4. **Domain inversion.** CCG/arena route *tasks* to models. argued.dev
   routes a *PR* to argumentative reviewers and asks "is this safe to
   merge?"

## Show HN positioning

Lead with what's new. Name-check both ancestors so Chinese readers find
continuity via the linux.do 补档 thread:

> argued.dev — paste a PR URL, 4 agents argue, one verdict. Built on the
> CCG patch-only security model (RIP `fengshao1227/ccg-workflow`,
> continued as `mingrath/arena-workflow`). Difference: argued.dev is
> adversarial QA on a PR, not task routing — and a Darwin failure-prior
> corpus catches the rubber-stamp APPROVE.
