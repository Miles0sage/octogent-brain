# claude-brain integration

**Repo: <https://github.com/Miles0sage/octogent-brain>**

This is a **fork of [hesamsheikh/octogent](https://github.com/hesamsheikh/octogent)** wired into
the [`claude-brain`](https://github.com/Miles0sage) self-improvement stack. The original
octogent — built by Hesam Sheikhalishahi — is a multi-agent terminal/canvas console for
Claude Code. This fork adds a small surface so the same console can introspect the
claude-brain runtime that lives next to it on disk.

Upstream is preserved verbatim; everything here is additive.

## Portability note

Paths in this guide use placeholders (`${CLAUDE_BRAIN_ROOT}`,
`${CLAUDE_USER_ROOT}`, `<octogent-repo>`, etc.) — the env-var table under
**Configuration** lists the env vars the code actually honors plus their
defaults. The original author's reference deployment uses `/root/...`, but
no path in this codebase is hard-coded; everything is configurable via env
var or CLI flag, and untracked paths are prose placeholders only.

## What this fork adds

| Surface | Path | Why |
|---|---|---|
| **Endpoint A** | `GET /api/claude-brain/daemons` | Surface the live state of the 5 self-improvement systemd units (`skill-evolve.{timer,service}`, `dpo-harvester.{timer,service}`, `infra-context-dump.timer`) without shelling out from the browser. |
| **Endpoint B** | `GET /api/claude-brain/dpo-recent?days=N` | Read-only metadata feed of the DPO preference-pair JSONLs that the harvester writes nightly. Counts lines and bytes per file; never streams contents. |
| **Endpoint C** | `GET /api/claude-brain/memory` | Inventory of `~/.claude/agent-memory/<scope>/*.md` and per-project `MEMORY.md` files so the console can show how much accumulated context the host carries. |
| **Panel** | `Brain` tab (nav index 9) | React component `ClaudeBrainDaemons.tsx` rendering Endpoint A as a 2-column card grid with active/inactive pills, relative timestamps, and an explicit refresh button. |
| **Host bind patch** | `apps/api/src/cli.ts` | One-line change so `HOST=0.0.0.0` actually binds the API to the requested interface (default upstream binds `127.0.0.1` only). Required to expose the console on Tailscale. |
| **packageManager strip** | `package.json` | The upstream `packageManager: "pnpm@10.4.1"` field was incompatible with the host's pinned pnpm — formatting normalized via biome. |

Each endpoint degrades gracefully: if the target path or unit is missing on the host the
response is a valid empty payload plus a `note` field explaining what was not found. Nothing
crashes when the claude-brain stack is absent — this fork still works as plain octogent.

## Upstream attribution

- **Upstream repo**: <https://github.com/hesamsheikh/octogent>
- **Upstream author**: Hesam Sheikhalishahi
- **License**: MIT, preserved verbatim in `LICENSE`. This fork inherits the same MIT.
- The original octogent test suite, primary navigation pattern, request-handler routing
  table, and React component shape are all reused — every claude-brain addition follows the
  existing house style (vitest tests, `ApiRouteHandler` shape, `console-canvas-*.css` panel
  styling). No upstream files were renamed or relocated.

## claude-brain stack overview

claude-brain is a self-improvement layer for Claude Code that lives at
`${CLAUDE_BRAIN_ROOT}` (default `/root/claude-brain` on the author's box).
The full description is in `${CLAUDE_BRAIN_ROOT}/CLAUDE.md`; the short
version:

- **74 standalone skills** under `~/.claude/skills/` plus 11 archived language packs.
- **6 self-improvement daemons**: `dpo-harvester` (clusters tool-failure events into
  preference pairs), `skill-evolve` (mutates `SKILL.md` content from those pairs, gated by
  assertions), `infra-context-dump` (refreshes `context/infra.md`), plus per-event hooks
  `route-around-known-failures`, `tokens-per-session-emitter`, and
  `agent-instrumentation-hook`.
- **Observability substrate** at `localhost:4000` that ingests every PreToolUse / PostToolUse
  / Stop hook event into a SQLite + Vue dashboard.
- **Per-agent memory scopes** under `~/.claude/agent-memory/<role>/*.md` plus
  `~/.claude/projects/*/memory/MEMORY.md` for project-scoped knowledge.
- **Lore wiki** at `<lore-wiki-root>` (66 markdown files, agentic patterns
  reference; the author's deployment uses `/root/wikis/ai-agents/wiki/`).

The integration keeps a clean separation: octogent owns the UI and terminal multiplexing,
claude-brain owns the data and the self-modification loop. The 3 endpoints in this fork are
the bridge.

## How they integrate

1. **Daemons endpoint** shells `systemctl is-active` + `systemctl show` for each tracked
   unit. Output is an array of `{name, kind, active, last_trigger_iso, next_trigger_iso}`
   for timers and `{name, kind, active, last_run_iso, result}` for services. The Brain panel
   renders one card per daemon with a green/red pill and a `Xm ago` relative timestamp.
2. **DPO recent endpoint** walks `dpo-pairs/*.jsonl`, filters to the last `?days=N` (default
   7) by mtime, and returns metadata only — never the file contents. The line count is the
   number of preference pairs harvested that day; this is the moat-growth metric.
3. **Memory endpoint** walks `~/.claude/agent-memory/<scope>/` (skipping `archive/`) for
   per-scope file/line/last-modified stats, plus per-project `MEMORY.md` files for
   accumulated project knowledge.

The existing `claudeSkills.ts` scanner in `apps/api/src/` already reads
`~/.claude/skills/`, so the suggested-skills feature in tentacles surfaces claude-brain
skills automatically with no extra wiring on this fork's side.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` (upstream) | Bind interface for the API + static frontend. Set to `0.0.0.0` to expose over Tailscale / LAN. |
| `OCTOGENT_ALLOW_REMOTE_ACCESS` | `0` | When set, the API accepts non-loopback `Host:` and `Origin:` headers. Required when binding to `0.0.0.0`. |
| `OCTOGENT_NO_OPEN` | unset | Suppress the auto-open browser tab on startup. Useful for headless / VPS hosts. |
| `CLAUDE_BRAIN_ROOT` | `/root/claude-brain` | Override the claude-brain repo root for the DPO endpoint. Honored in `apps/api/src/createApiServer/claudeBrainRoutes.ts`. |
| `CLAUDE_USER_ROOT` | `/root/.claude` | Override the per-user Claude state root for the memory endpoint. Honored in `apps/api/src/createApiServer/claudeBrainRoutes.ts`. |
| `OCTOGENT_DIR` | `/root/octogent` | Override the octogent repo root for the `bin/spawn-team.sh` and `bin/agency-chart.sh` helpers. Honored in those scripts only. |

The Lore wiki path is not currently configurable through an env var — it is
referenced only in prose for orientation. If you need to relocate it, point
the documentation at `<lore-wiki-root>` for your install.

Recommended startup for a Tailscale-exposed host (replace `<your-project>`
with the absolute path to the project you want octogent to open against,
and `<octogent-repo>` with the absolute path to this fork's clone):

```bash
cd <your-project> && \
  HOST=0.0.0.0 \
  OCTOGENT_ALLOW_REMOTE_ACCESS=1 \
  OCTOGENT_NO_OPEN=1 \
  nohup node <octogent-repo>/bin/octogent > /tmp/octogent.log 2>&1 &
```

## Specialized Agent Layer

Octogent's `terminal create` API can spawn role-specialized Claude Code instances under one tentacle. Each role boots with a system prompt template that restricts tools, suggests skills, and enforces an auto-research loop against the Lore MCP wiki.

| Role | One-liner |
|---|---|
| `bd-research` | Investigates topics. Reads Lore first, then Perplexity / Exa / Context7. Read-only on source code. |
| `bd-builder` | Ships code under TDD. Tests first, `.venv/bin/pytest` before done. |
| `bd-reviewer` | Read-only structured review with severity-rated comments. |
| `bd-synthesizer` | NotebookLM-style paragraphs with span-level verbatim citations. |
| `bd-planner` | Plans with binary acceptance contracts. Read-only on source. |

### Spawn helper

```bash
bash "${OCTOGENT_DIR}/bin/spawn-team.sh" \
  --topic "implement D9 4-format audio styles" \
  --tentacle audio \
  --roles "research,builder,reviewer"
```

Spawns a parent coordinator (upstream `swarm-parent` template) plus one child per role using the matching `bd-<role>` prompt template at `${OCTOGENT_DIR}/prompts/`. Use `--dry-run` to preview the `terminal create` invocations.

### Auto-research loop (Karpathy-style)

Every role's prompt template enforces two contracts:

- BEFORE the work: `lore_search "<topic>"`, read top hits, cite priors.
- AFTER the work: `lore_chronicle` with title `<role> learned: <topic>` and a one-paragraph distilled lesson.

Lore is wired through the host's `~/.mcp.json` and inherited by the spawned Claude Code processes — no octogent-side MCP wiring is required. If the `mcp__lore__*` tools are absent in a given terminal, the agent logs a single stderr note and continues without the loop. This is opt-in by the prompt template; no fallback shim is added.

This mirrors Andrej Karpathy's continuous-learning thesis: durable agent improvement comes from *doing the work, reflecting on quality, and writing a one-paragraph distilled lesson back to a persistent knowledge base for future invocations*. Lore is that knowledge base; the chronicle calls are the reflection step.

The companion skill is `~/.claude/skills/briefingdeck-spawn-team/SKILL.md`.

## Agency-Swarm Layer

Adapted from [VRSEN/agency-swarm](https://github.com/VRSEN/agency-swarm) (MIT). Octogent's existing parent-worker spawn pattern is great for "spawn 3 workers, merge their branches"; it does not, on its own, support "ask 5 specialists the same question and pick the best answer." The Agency-Swarm Layer adds three lifts on top of the existing terminal + channel surface, all 100% Claude-native — no Python, no OpenAI Assistants API.

### Concepts

| Lift | What it is | File |
|---|---|---|
| **`agency_chart`** | A first-class declarative JSON topology — `entryPoints`, `flows: [{from, to}]`, `sharedInstructions`. Diffable, versionable, validated. | `packages/core/src/domain/agencyChart.ts`, example at `<your-project>/.octogent/agency-chart.json` |
| **Voting coordinator** | New prompt template `swarm-vote-parent.md` that fans one question to every specialist, scores replies on groundedness + specificity + cost, picks the winner, writes a JSON artifact. | `prompts/swarm-vote-parent.md` |
| **`AGENCY.md` shared instructions** | One markdown file prepended to every specialist's system prompt at spawn time. Carries mission + toolchain + DONE/BLOCKED contract. Mirrors agency-swarm's `shared_instructions=...` semantics from `agency/core.py:152-161`. | `<your-project>/.octogent/AGENCY.md` |

### CLI surface

```bash
# Validate a chart before spawning.
bash bin/agency-chart.sh --validate <your-project>/.octogent/agency-chart.json

# Spawn a vote team. Coord uses swarm-vote-parent; chart is validated first.
bash bin/spawn-team.sh \
  --topic "ADK Python vs LangGraph for D2?" \
  --tentacle agents \
  --roles "research,builder,reviewer,synthesizer,planner" \
  --vote \
  --chart <your-project>/.octogent/agency-chart.json
```

`--dry-run --vote` prints the channel-send commands the coord would issue, without spawning live Claude Code processes — safe for CI / smoke tests.

### Validator

`validateChart()` rejects: missing entrypoints, missing shared instructions, empty flows, self-edges, duplicate edges, dangling entrypoint references, and cycles (DFS three-color). 11 vitest cases at `packages/core/tests/agencyChart.test.ts`.

### Vote artifact

Each completed vote writes `~/.octogent/projects/<projectId>/votes/<voteId>.json` with `{ question, specialists, responses: [{specialist, response, score, cost_usd}], winner, rationale }`. These artifacts are observable (replay), and become DPO training pairs for the claude-brain GEPA reflection loop (winner = `chosen`, runners-up = `rejected`).

### Attribution

Single attribution comment per file: `# Adapted from VRSEN/agency-swarm (MIT)`. Concepts lifted: `agency_chart` (`agency/setup.py:27-262`), `SendMessage` description-build pattern (`tools/send_message.py:87-180`), `shared_instructions` prepend (`agency/core.py:152-161`). No verbatim Python ported. Both projects are MIT, no obligations beyond the attribution lines.

The companion skill is `~/.claude/skills/briefingdeck-agency-vote/SKILL.md`.

## Roadmap

Possible next integrations, in rough order of value:

1. **Forward octogent hook events to `:4000`** — every tool call already has a hook lane;
   tap it the same way the rest of claude-brain does so octogent sessions show up in the
   observability dashboard.
2. **Surface `learnings.md`** — each in-scope skill writes 1-3 bullets per invoke. A small
   panel showing the running tail of every skill's learnings would close the loop visually.
3. **Hook the GEPA loop** — render `swebench-ab` arm comparisons + `delta_pp` metrics so the
   skill-evolve gate decisions are visible from the same UI.
4. **Mount tentacles as departments** — the `project-tentacle-planner` skill can scaffold a
   department-per-tentacle layout with scoped `CONTEXT.md + todo.md`. Treat each tentacle
   as a department with its own claude-brain memory scope.
5. **DPO browser** — the current endpoint returns metadata only; a paginated content view
   would let operators inspect why a pair was harvested without running a CLI.

## License

MIT. Derived from the upstream MIT license carried in `LICENSE`. Attribution chain:

- claude-brain integration code in this fork: MIT, © contributors of `Miles0sage/octogent-brain`.
- Original octogent: MIT, © Hesam Sheikhalishahi (`hesamsheikh/octogent`).

The `LICENSE` file at the repo root is left untouched.
