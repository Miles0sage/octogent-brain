# @octogent/supervisor

> Mechanical-supervision substrate for autonomous coding agents.
> Aider writes, Claude evaluates, your gate keeps both honest.

Cross-CLI dispatcher + verdict-gate that catches rubber-stamp passes and
forces re-iteration. Anthropic shipped `agent-view` and `agent-teams` as
native primitives; this package fills the gap they didn't — a structural
verifier that runs in a separate OS process and refuses to rubber-stamp
its own work.

## Why

The standard pattern for LLM-driven coding agents is a single context
that writes AND reviews. That context inherits the writer's confidence
framing and rubber-stamps. The fix is mechanical: keep the writer in
one OS process, the evaluator in another, and trust the numbers not
the prose.

This package ships three pieces:

1. **`verdict-gate`** — pure-TS parser + evaluator for the reviewer's
   JSON verdict. Catches `{verdict: "pass"}` with sub-threshold scores
   ("gate-trust-numbers" rule) and forces re-iteration.
2. **`review-fix-loop`** — decides whether to continue, approve, max out,
   or false-positive-terminate based on rolling iteration history.
3. **`createVerdictWatcher`** — stateful scanner over a streaming stdout
   buffer. Drop it in any `child.stdout.on('data', ...)` callback and
   get a re-injection prompt when the agent lies about quality.

Plus a cross-CLI dispatcher (`dispatchTask`) that loads a `routing.json`,
picks the right driver per task-type (refactor → Aider, verify → Claude
plan-mode), probes binary + env health, and spawns the subprocess.

## Install

```bash
npm install @octogent/supervisor
```

Requires Node 22+.

## Quickstart — supervise a Claude session

```typescript
import { spawn } from "node:child_process";
import { createVerdictWatcher } from "@octogent/supervisor";

const watcher = createVerdictWatcher();
const child = spawn("claude", [
  "--print",
  "--permission-mode",
  "plan",
  "Review this diff and emit a final-line JSON verdict.",
]);

child.stdout.on("data", (chunk) => {
  const obs = watcher.observeChunk(chunk.toString("utf8"));
  if (obs.kind === "verdict-blocked") {
    console.log(`[gate] blocked iter ${obs.iteration}: ${obs.gate.reason}`);
    // Re-dispatch with the re-injection prompt
    child.stdin?.write(obs.reinjectPrompt);
  } else if (obs.kind === "verdict-approved") {
    console.log(`[gate] approved: g=${obs.verdict.scores.groundedness}`);
  } else if (obs.kind === "loop-terminated") {
    console.log(`[gate] terminated after ${obs.iterations.length} iters`);
  }
});
```

## Cross-CLI dispatch

`routing.json` (drop at `~/.octogent-better/routing.json`):

```json
{
  "version": 1,
  "defaultProvider": "claude-code",
  "drivers": [
    {
      "provider": "aider",
      "transport": "stdio",
      "capabilities": ["writer"],
      "command": "aider",
      "baseArgs": ["--no-pretty", "--yes"],
      "requiredEnv": ["OPENAI_API_KEY"],
      "maxCostUsd": 1.0
    },
    {
      "provider": "claude-code",
      "transport": "stdio",
      "capabilities": ["writer", "evaluator", "all"],
      "command": "claude",
      "baseArgs": ["--print", "--permission-mode", "plan"],
      "requiredEnv": [],
      "maxCostUsd": 2.0
    }
  ],
  "rules": [
    {
      "taskType": "refactor",
      "preferred": "aider",
      "fallback": ["claude-code"],
      "extraArgs": ["--architect"]
    },
    {
      "taskType": "verify",
      "preferred": "claude-code",
      "fallback": [],
      "extraArgs": []
    }
  ]
}
```

```typescript
import { dispatchTask, loadRoutingConfig } from "@octogent/supervisor";

const loaded = loadRoutingConfig();
if (!loaded.ok) throw new Error(`routing.json invalid: ${loaded.reason}`);

const result = await dispatchTask(loaded.config, {
  taskType: "refactor",
  taskInput: "rename function foo to bar in src/lib.ts",
  cwd: process.cwd(),
  dryRun: false,
});

console.log(`dispatch ${result.dispatch_id} status:`, result.health);
for (const event of result.events) {
  if (event.kind === "stdout") process.stdout.write(event.data);
}
```

## The "gate-trust-numbers" rule

When the reviewer emits `{"verdict": "pass", "scores": {"groundedness": 0.62}}`,
the gate overrides the textual "pass" because 0.62 is below the 0.85 threshold.
This is the load-bearing anti-rubber-stamp mechanic. Source: Anthropic
2026-03-24 *Harness design for long-running application development* —
evaluators that share writer context "talk themselves into" passing bad work.

## Why "Mechanical Supervision"

OS-process isolation between the writer and the reviewer makes context
contamination structurally impossible. The reviewer can't see the writer's
chain-of-thought; it can only see the final artifact. Hosico02 named this
pattern (separate `claude -p` processes); we generalize it across vendors.

## License

MIT — see [LICENSE](./LICENSE).

## See also

- [@octogent/core](../core) — pure-domain types and verdict-gate logic
- [octogent-brain](https://github.com/Miles0sage/octogent-brain) — the
  full dashboard that wires this substrate into a tentacle-terminal UI
