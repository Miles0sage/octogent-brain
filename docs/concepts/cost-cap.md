# Cost-cap enforcement

Octogent ships a 3-layer cost-cap that hard-stops dispatches before they spend
money you don't have. It is the spend-trust moment in the cross-vendor vote
demo and the differentiator that unlocks the Small-Co tier.

## The three layers

| Layer        | Default | Trigger                                              | Action                                         |
|--------------|---------|------------------------------------------------------|------------------------------------------------|
| per-dispatch | $0.50   | One vote.dispatch sum-estimate exceeds the cap       | HTTP 402, audit `cap-fire`, no subprocess spawn |
| per-session  | $5.00   | sessionSpent + estimate exceeds the cap              | HTTP 402, audit `cap-fire`, no subprocess spawn |
| per-day      | $20.00  | daySpent + estimate exceeds the cap (UTC rollover)   | HTTP 402, audit `cap-fire`, no subprocess spawn |

The per-dispatch layer fires first; per-session second; per-day last. The
verdict carries `reason`, `capUsd`, and `remainingUsd` so the UI can render
a meaningful explanation.

## Tier gating

| Tier      | Layers active        | Spend subtab | Audit CSV export |
|-----------|----------------------|--------------|------------------|
| `free`    | all 3 (advisory)     | hidden       | hidden           |
| `small-co`| all 3 + audit log    | visible      | visible          |

Tier is controlled by `OCTOGENT_TIER` (default: `free`).

## Configuration (env vars)

| Variable                       | Default | Purpose                                             |
|--------------------------------|---------|-----------------------------------------------------|
| `OCTOGENT_PER_DISPATCH_USD`    | `0.50`  | Single vote.dispatch ceiling                        |
| `OCTOGENT_PER_SESSION_USD`     | `5.00`  | Per-session cumulative ceiling                      |
| `OCTOGENT_PER_DAY_USD`         | `20.00` | Per-day cumulative ceiling (resets at 00:00 UTC)    |
| `OCTOGENT_TIER`                | `free`  | `free` or `small-co`                                |
| `OCTOGENT_AUDIT_LOG`           | `/tmp/octogent-audit.jsonl` | JSONL audit-log path             |

## Provider rate table (2026-05)

```
claude-code   : $3.00 in / $15.00 out per 1M tokens (Sonnet 4 list)
codex         : $0.25 in / $2.00  out per 1M tokens (gpt-5-codex-mini)
gemini-cli    : $1.25 in / $10.00 out per 1M tokens (Gemini 2.5 Pro)
aider         : $0    in / $0     out per 1M tokens (local backends)
```

Token estimate per dispatch: `ceil(promptChars / 4) + 500 output tokens`. The
output budget is intentionally conservative — most reviewer verdicts run under
300 tokens, leaving headroom for the issues[] list.

## Audit log shape

Each cap event lands as a single JSON line in `OCTOGENT_AUDIT_LOG` and the
in-memory ring buffer behind `GET /api/claude-brain/cost-cap/audit`:

```jsonl
{"ts":"...","event":"vote-dispatched","sessionId":"...","providers":[...],"estimatedUsd":0.04}
{"ts":"...","event":"voter-completed","sessionId":"...","provider":"claude-code","actualUsd":0.02}
{"ts":"...","event":"cap-fire","sessionId":"...","providers":[...],"capUsd":0.5,"reason":"would-exceed-per-dispatch"}
```

The Spend subtab in the Monitor view tails the ring buffer + exports CSV for
SIEM ingestion. JSONL on disk is the source of truth — the ring buffer is a
last-100-entries view of the same stream.

## API surface

| Method | Path                              | Returns                              |
|--------|-----------------------------------|--------------------------------------|
| POST   | `/api/claude-brain/votes/dispatch`| 200 vote outcome OR 402 cost-cap verdict |
| GET    | `/api/claude-brain/cost-cap`      | `{ config, usage: { daySpentUsd, dayStart } }` |
| GET    | `/api/claude-brain/cost-cap/audit`| `{ entries: AuditEntry[] }` (last 100) |

All three routes inherit the same C1 auth gate as the existing claude-brain
routes (bearer token via `OCTOGENT_API_KEY` or loopback by default).

## UX surfaces

- **Stat-tile** — left of the existing Claude usage rail in the runtime
  status strip. `$X.XX / $YY.YY` + 10-segment bar. Slate < 50%, amber 50-90%,
  red+pulse 90-100%.
- **Pre-flight pill** — next to the "Run cross-vendor vote" button. Shows
  estimated cost + voter count before commitment; flips to "Would exceed
  daily cap — $X.XX left" when blocked.
- **Cap-fire visual** — the vote card gets `data-cap-fire="true"` when the
  API returns 402; the bar-color shift is persistent (renders correctly in
  screenshots/gifs, no transient toast).
- **Spend subtab** — visible only when `tier=small-co`. Renders the audit
  log + CSV-export button.

## Non-goals (deferred)

- Live $-rate lookup from provider APIs (the rate table is static; users
  update env vars when rates change)
- Multi-tenant budget API (enterprise tier work)
- Prompt-cache discounting math (would require per-provider response shape
  parsing)
- Retroactive billing reconciliation (we track estimates, not actuals)
