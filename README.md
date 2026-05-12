<div align="center">

<img width="1500" height="500" alt="Octogent header" src="./static/images/octogent-header.png" />
<br/>
<br/>

<strong>Three LLMs vote on every diff. Local. Free. The verifier Anthropic can't ship.</strong>
<br />
<br />

[![npm](https://img.shields.io/npm/v/@octogent/supervisor?style=flat-square)](https://www.npmjs.com/package/@octogent/supervisor)
![Last Update](https://img.shields.io/github/last-commit/hesamsheikh/octogent?label=Last%20Update&style=flat-square)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22+-5FA04E?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Follow on X](https://img.shields.io/badge/Follow%20on-X-000000?style=flat-square&logo=x)](https://x.com/Hesamation)
[![Discord](https://img.shields.io/badge/Discord-Open%20Source%20AI%20Builders-5865F2?style=flat-square&logo=discord&logoColor=white)](https://discord.gg/vtJykN3t)

</div>

# Octogent — cross-vendor mechanical supervision for AI coding agents

## Quickstart

```bash
npm install @octogent/supervisor @octogent/core
```

Spawn three voters across three vendors, collect their verdicts, tally the
vote mechanically. No vendor reviews its own diff:

```ts
import { dispatchTask, tallyVotes, loadRoutingConfig, DEFAULT_VOTE_CONFIG,
         parseReviewerVerdict, type VoterVerdict } from "@octogent/supervisor";

const { config } = await loadRoutingConfig({ cwd: process.cwd() });
const task = { taskType: "verify", taskInput: "Does this diff cite the source files it touches?", cwd: process.cwd() };

const runs = await Promise.all(
  ["claude-code", "codex", "gemini-cli"].map(() => dispatchTask(config, task)),
);
const verdicts: VoterVerdict[] = runs.map((r) => ({
  provider: r.invocation?.provider ?? "unknown",
  verdict: parseReviewerVerdict(r.events.map((e) => ("data" in e ? e.data ?? "" : "")).join("")),
  raw_output: r.events.map((e) => ("data" in e ? e.data ?? "" : "")).join(""),
}));

console.log(tallyVotes(verdicts, DEFAULT_VOTE_CONFIG));
// → { winner: "pass" | "fail" | "no-consensus", reason, consensus_count, dissent_count, verdicts }
```

## What it does

Octogent is mechanical supervision for AI coding agents. Every diff your agent
produces is reviewed by a *different vendor's* model before it touches your
repo — Aider writes, Claude reviews, Codex breaks ties. It runs locally, costs
nothing extra beyond the API keys you already have, and catches the class of
confabulation that single-vendor self-review rubber-stamps. Because the
reviewer is structurally not the writer, no Anthropic, OpenAI, or Anysphere
release can ship this — it requires a third party who is willing to route
across all three.

**What it catches that single-vendor self-review doesn't:**

- Rubber-stamp "pass" verdicts that omit the groundedness/specificity numbers
  the rubric demanded — `parseReviewerVerdict` rejects, `tallyVotes` records
  it as unparseable instead of letting it slip.
- Missing JSON tail / hallucinated tool output — voters that fail to emit a
  parseable verdict can't carry the vote.
- Cross-vendor disagreement on the same diff — when Claude says pass and
  Codex says fail with low groundedness, `strong-reject` fires and the diff
  is blocked regardless of majority.

![90s demo](./docs/launch/demo-90s.gif)

### Fork notice

This is a `claude-brain`-extended fork of
[`hesamsheikh/octogent`](https://github.com/hesamsheikh/octogent) by Hesam
Sheikhalishahi. All upstream features — tentacles, scoped context, the
`todo.md` execution surface, the multi-terminal orchestration UI — remain
intact and unmodified. The v0.2 additions (cross-vendor vote, CMA rubric
portability, cost caps, audit log, the `@octogent/supervisor` npm package)
are layered on top. Upstream attribution and the MIT license are preserved.

## Cross-CLI drivers

Octogent dispatches across four installed CLIs over stdio. Each driver is
declared in `routing.json` (copy `routing.example.json`); the dispatcher
refuses to spawn anything not on the allowlist and forwards only the env
variables a driver explicitly declares in `requiredEnv`.

| Provider      | Command       | Role                       | Transport | Health |
|---------------|---------------|----------------------------|-----------|--------|
| `claude-code` | `claude`      | evaluator                  | stdio     | ready  |
| `aider`       | `aider`       | writer                     | stdio     | ready  |
| `codex`       | `codex exec`  | evaluator (tie-breaker)    | stdio     | ready  |
| `gemini-cli`  | `gemini`      | intel                      | stdio     | ready  |

See [`docs/concepts/runtime-and-api.md`](./docs/concepts/runtime-and-api.md)
for the full driver contract.

### claude-brain integration

The Brain panel and three `/api/claude-brain/*` endpoints expose the
self-improvement daemons that ship cross-vendor verdicts back into a Darwin
dataset. Details in
[`CLAUDE_BRAIN_INTEGRATION.md`](./CLAUDE_BRAIN_INTEGRATION.md).

## CMA rubric portability (v0.2)

Octogent adopts Anthropic's outcome-grader schema from
[`claude-cookbooks` PR #599](https://github.com/anthropics/claude-cookbooks)
(2026-05-06) as the voter input contract. Paste an Anthropic-published
rubric, get the same rubric graded across Claude / Codex / Gemini, vote
mechanically. We don't compete with Anthropic Managed Agents — we route
their pattern across vendors they structurally cannot reach.

```ts
await fetch("http://localhost:8787/api/claude-brain/votes/dispatch", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    taskInput: "Does this diff cite the source files it touches?",
    taskType: "verify",
    providers: ["claude-code", "codex", "gemini-cli"],
    rubric: { rubric_id: "anthropic-cookbook-outcome-grader", rubric_version: "1.0.0",
              criteria: [{ name: "grounded", description: "Cites source files", weight: 1.0 }],
              passing_threshold: 0.8 },
  }),
});
```

Full contract at [`docs/concepts/cma-portability.md`](./docs/concepts/cma-portability.md).

## Cost caps + audit log (v0.2)

Three layered caps — per-dispatch, per-session, per-day — hard-stop the
cross-vendor vote route before any subprocess spawns. Configurable via
`OCTOGENT_PER_DISPATCH_USD`, `OCTOGENT_PER_SESSION_USD`,
`OCTOGENT_PER_DAY_USD`. Tripping the cap returns HTTP 402 with a structured
`capError` body. Every fire writes a JSONL audit entry to
`OCTOGENT_AUDIT_LOG` (default `/tmp/octogent-audit.jsonl`). The UI surfaces a
stat-tile next to the Claude usage rail and a pre-flight pill on the vote
button. The Spend subtab is tier-gated via `OCTOGENT_TIER=small-co`.

Full contract at [`docs/concepts/cost-cap.md`](./docs/concepts/cost-cap.md).

## Status / roadmap

- **v0.1** ✓ cross-vendor verifier loop, 4 stdio drivers, dashboard, vote tally
- **v0.2** ✓ CMA rubric portability + 3-layer cost caps + audit log + npm publish
- **v0.3** (deferred) — Darwin loop (we learn from rejected dispatches across
  vendors), tool-call routing, marketplace adapters

The roadmap is brand-compounding: every rejected vote across vendors enriches
a dataset Anthropic can't collect, because Anthropic can't route to Codex.

## Upstream — what the fork inherits

Below this line is the original `hesamsheikh/octogent` README content,
preserved verbatim where the upstream behavior is unchanged. The
cross-vendor verifier and v0.2 additions above layer on top of it.

It's really not fun to have **ten Claude Code sessions open at once**, constantly switching between them and trying to remember what each one was supposed to do. *Things get blurry fast* when one agent is doing documentation, another is touching the database, another is changing the API, and another is somewhere in the frontend. **Octogent** tries to fix that by giving each job its own <u>scoped context, notes, and task list</u>, while also making it possible for Claude Code to **spawn other Claude Code agents**, assign them work, and communicate with them.

## The Vision

This repo is a personal exploration of what an AI coding environment might look like when terminal coding agents are treated as parts of a bigger orchestration layer, not the final interface by themselves. The point is not to hide **Claude Code** behind abstractions. The point is to make *multi-agent work less chaotic for the developer* on a real codebase.

## Screenshots

<div align="center">
<table>
<tr>
<td><img src="./static/images/preview_1.jpg" alt="Screenshot 1" width="100%"/></td>
<td><img src="./static/images/preview_2.jpg" alt="Screenshot 2" width="100%"/></td>
</tr>
<tr>
<td><img src="./static/images/preview_3.jpg" alt="Screenshot 3" width="100%"/></td>
<td><img src="./static/images/preview_4.jpg" alt="Screenshot 4" width="100%"/></td>
</tr>
<tr>
<td><img src="./static/images/preview_5.jpg" alt="Screenshot 5" width="100%"/></td>
<td><img src="./static/images/preview_6.jpg" alt="Screenshot 6" width="100%"/></td>
</tr>
</table>
</div>

## What Octogent Does for You

- **Creates tentacles as context layers** so agents can work with scoped markdown files instead of broad, messy chat context
- **Uses `todo.md` as an execution surface** so tasks stay visible, trackable, and ready for delegation
- **Runs multiple Claude Code terminals** so one developer can coordinate several coding sessions at once
- **Spawns child agents from todo items** so parallel work has a concrete source of truth
- **Supports inter-agent messaging** so workers and coordinators can report completion, blockers, and handoff notes
- **Keeps agent-facing context in files** so the system is more durable than a single prompt thread
- **Provides a local API and UI** for terminal lifecycle, persistence, websocket transport, and orchestration

A **tentacle** is a folder under `.octogent/tentacles/<tentacle-id>/` that holds agent-readable markdown such as `CONTEXT.md`, `todo.md`, and any extra notes needed for that slice of the codebase.

The octopus metaphor is literal: *one octopus, many tentacles, different work happening at the same time*.

## Tentacles

A **tentacle** is a scoped job container. It gives one slice of work its own files, notes, and `todo.md` so the agent is not forced to reconstruct the entire codebase context from chat history.

What it does:

- keeps context local to one area such as documentation, database work, API changes, or frontend work
- gives agents durable files they can read and update
- provides a natural source for delegation through todo items

For the full model, see [Tentacles](docs/concepts/tentacles.md) and [Working With Todos](docs/guides/working-with-todos.md).

## Context, Notes, and Task Lists

In Octogent, a tentacle is not only a task bucket. It is also where the job keeps its local context. That can include notes about one part of the codebase, implementation details, handoff files, and a `todo.md` that tracks what still needs to happen. A Claude Code agent can read and update those files as the work moves forward.

That means you can:

- keep documentation, database, API, or frontend work separated into different job contexts
- store the notes that help an agent understand that part of the codebase
- spawn one agent for one specific item
- break a larger job into multiple items
- launch a swarm so several agents work through the list in parallel
- use the files inside the tentacle as the shared source of truth for what is done and what is left

For the full model, see [Tentacles](docs/concepts/tentacles.md) and [Working With Todos](docs/guides/working-with-todos.md).

## Claude Code Managing Claude Code

One of the main ideas here is that **Claude Code** should not only be treated as a single terminal session waiting for a human prompt. In Octogent, one Claude Code agent can coordinate other Claude Code agents, assign them specific jobs, and exchange short messages with them while the human stays at the orchestration layer.

This is different from Claude Code's subagent spawning, since it allows you to directly see and control what each worker agent is doing.

That means Octogent is not just a dashboard for multiple terminals. It is also a way to structure parent-worker behavior around scoped tasks and shared context files.

For the current model, see [Orchestrating Child Agents](docs/guides/orchestrating-child-agents.md) and [Inter-Agent Messaging](docs/guides/inter-agent-messaging.md).

## How It Works

Octogent separates three concerns that usually get mixed together in a pile of terminals:

1. **Context** lives in `.octogent/tentacles/<tentacle-id>/`. `CONTEXT.md` explains the area, `todo.md` supplies executable work items, and extra markdown files hold notes or handoffs.
2. **Execution** lives in terminal records and PTY sessions managed by the local API. A terminal can attach to an existing tentacle, and several terminals can share one tentacle during swarm work.
3. **Isolation** is optional. Shared terminals run in the main workspace; worktree terminals run under `.octogent/worktrees/<worktree-id>/` on `octogent/<worktree-id>` branches.

Deck reads the tentacle files directly, parses checkbox items from `todo.md`, and uses incomplete items to generate worker prompts. Claude hooks feed the API with agent state, transcript, and idle events so the UI can show more than raw terminal output.

## Local development

<details>
<summary><strong>Local development</strong></summary>

```bash
pnpm install
pnpm dev
```

This starts the API and web app for local development.

</details>

<details open>
<summary><strong>Current install status</strong></summary>

For local development:

```bash
pnpm install
pnpm dev
```

For a local global CLI install from a clone:

```bash
pnpm install
pnpm build
npm install -g .
octogent
```

The `@octogent/supervisor` package on npm provides the cross-vendor vote
substrate as a library. The full `octogent` CLI / UI is not yet published to
npm — install from a clone for the dashboard.

</details>

On first run, **Octogent** creates the local `.octogent/` scaffold automatically, assigns a stable project ID, picks an available local API port starting at `8787`, and opens the UI unless `OCTOGENT_NO_OPEN=1` is set.

## Requirements

- Node.js `22+`
- `claude` installed for the supported agent workflow
- `git` for worktree terminals
- `gh` for GitHub pull request features
- `curl` for the current Claude hook callback flow

Startup fails if neither `claude` nor another supported provider binary is installed. The current docs only cover **Claude Code**.

## What persists

- `.octogent/` keeps project-local scaffold and worktrees
- `~/.octogent/projects/<project-id>/state/` keeps runtime state, transcripts, monitor cache, and metadata
- `.octogent/tentacles/<tentacle-id>/` keeps the context files and todos that agents read

PTY sessions survive browser reloads during the idle grace period, but they do **not** survive an API restart. Octogent marks previously running terminal records as `stale` on startup when it cannot reattach them to a live PTY session; use `octogent terminal list`, `stop`, `kill`, and `prune` to inspect and clean them up. Octogent caps live PTY sessions at 32 by default to protect the host; set `OCTOGENT_MAX_TERMINAL_SESSIONS` to a positive integer to tune that limit for larger orchestration runs.

## Release

Releases of the `@octogent/core` and `@octogent/supervisor` packages on npm are
tag-driven. To cut a release: bump the `version` field in both
`packages/core/package.json` and `packages/supervisor/package.json` to the same
new semver (e.g. `0.2.0`), commit the bump, then run
`git tag v0.2.0 && git push --tags`. The
[`npm publish` workflow](.github/workflows/npm-publish.yml) detects the tag,
validates that it matches both `package.json` versions, runs the full test
suite, and publishes both packages — `@octogent/core` first, `@octogent/supervisor`
second, so the supervisor's `workspace:*` dependency resolves to a registry
version that already exists. Tags must match `v[0-9]+.[0-9]+.[0-9]+` (no
pre-release suffixes for the `v0.1` line). Publishing requires the `NPM_TOKEN`
repo secret; without it the workflow hard-fails before touching the registry.

If a release goes out broken, the fastest rollback is `npm unpublish
@octogent/core@<version>` and `npm unpublish @octogent/supervisor@<version>`
within 72 hours of publish — npm permits unpublish inside that window. After
72 hours, unpublish is no longer allowed, so the recovery path is to bump the
patch version (e.g. `0.2.1`), fix the issue, and re-tag. Never reuse a
published version number; the workflow's pre-publish probe
(`pnpm view @octogent/<pkg>@<version>`) will refuse to overwrite an existing
release.

## Docs

- [Docs Home](docs/index.md)
- [Installation](docs/getting-started/installation.md)
- [Quickstart](docs/getting-started/quickstart.md)
- [Mental Model](docs/concepts/mental-model.md)
- [Tentacles](docs/concepts/tentacles.md)
- [Runtime and API](docs/concepts/runtime-and-api.md)
- [CMA rubric portability](docs/concepts/cma-portability.md)
- [Cost caps + audit log](docs/concepts/cost-cap.md)
- [Working With Todos](docs/guides/working-with-todos.md)
- [Orchestrating Child Agents](docs/guides/orchestrating-child-agents.md)
- [Inter-Agent Messaging](docs/guides/inter-agent-messaging.md)
- [CLI Reference](docs/reference/cli.md)
- [Filesystem Layout](docs/reference/filesystem-layout.md)
- [API Reference](docs/reference/api.md)
- [Experimental Features](docs/reference/experimental-features.md)
- [Troubleshooting](docs/reference/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)

## Contributor setup
Octogent is not actively reviewing pull requests right now. If you still open one and any code was written with AI, disclose which coding agent and model were used. For contributor workflow and expectations, see [CONTRIBUTING.md](CONTRIBUTING.md).
