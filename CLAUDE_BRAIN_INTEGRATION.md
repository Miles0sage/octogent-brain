# claude-brain integration

**Repo: <https://github.com/Miles0sage/octogent-brain>**

This is a **fork of [hesamsheikh/octogent](https://github.com/hesamsheikh/octogent)** wired into
the [`claude-brain`](https://github.com/Miles0sage) self-improvement stack. The original
octogent — built by Hesam Sheikhalishahi — is a multi-agent terminal/canvas console for
Claude Code. This fork adds a small surface so the same console can introspect the
claude-brain runtime that lives next to it on disk.

Upstream is preserved verbatim; everything here is additive.

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
`/root/claude-brain` on this host. The full description is in
`/root/claude-brain/CLAUDE.md`; the short version:

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
- **Lore wiki** at `/root/wikis/ai-agents/wiki/` (66 markdown files, agentic patterns
  reference).

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
| `CLAUDE_BRAIN_ROOT` | `/root/claude-brain` | Override the claude-brain repo root for the DPO endpoint. |
| `CLAUDE_USER_ROOT` | `/root/.claude` | Override the per-user Claude state root for the memory endpoint. |

Recommended startup for a Tailscale-exposed host:

```bash
cd /root/briefingdeck && \
  HOST=0.0.0.0 \
  OCTOGENT_ALLOW_REMOTE_ACCESS=1 \
  OCTOGENT_NO_OPEN=1 \
  nohup node /root/octogent/bin/octogent > /tmp/octogent.log 2>&1 &
```

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
