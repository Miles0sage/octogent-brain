# Live smoke tests — captured 2026-05-12T04:48:39.669536

Run against `http://localhost:8788` with the local `octogent` checkout at
the current branch tip.

Reproducer: `python3 docs/evidence/2026-05-12-real-tests.py --base-url http://127.0.0.1:8788`

> Examples below were captured on the original author's box; replace
> `<octogent-repo>` and any other placeholders with absolute paths from
> your own deployment.

## Test 1 — `GET /api/claude-brain/drivers`

```json
aider           health={"healthy": false, "reason": "env-missing", "missing": ["OPENAI_API_KEY"]}
claude-code     health={"healthy": true}
codex           health={"healthy": false, "reason": "transport-unsupported", "transport": "pty"}
gemini-cli      health={"healthy": false, "reason": "env-missing", "missing": ["GOOGLE_API_KEY"]}
```

## Test 2 — Rubber-stamp fixture through review-gate (deterministic)

```json
{
  "parsed_verdict": {
    "verdict": "pass",
    "improvements_exhausted": false,
    "issues": [
      "MAJOR retriever.py:88 chunk 12 not in source set"
    ],
    "scores": {
      "groundedness": 0.62,
      "specificity": 0.88
    }
  },
  "gate_decision": {
    "passes": false,
    "reason": "gate-trust-numbers: reviewer claimed pass but groundedness=0.62 < threshold=0.85"
  },
  "loop_decision": {
    "action": "continue"
  }
}
```

## Test 4 — M2 argv-injection guard (`--` end-of-options separator)

```json
{
  "provider": "claude-code",
  "command": "claude",
  "args": [
    "--print",
    "--permission-mode",
    "plan",
    "--",
    "--dangerously-skip-permissions This is the task body."
  ],
  "cwd": "<octogent-repo>",
  "envFlags": []
}
```
`--` separator at index 3; adversarial taskInput follows at index 4. Argv injection neutered.

## Test 5 — M3 cwd whitelist rejects `/etc`

```
HTTP 400: {"error":"cwd not within allowed workspace"}
```

---

Test 3 (live `claude --print` through vote endpoint) is NOT reproducible from
a fresh checkout without consuming Anthropic credits + an interactive Claude
login on the host. In this session, the same endpoint returned `winner=pass`
with a parseable JSON verdict from `claude-code` in about 13-15s via
`POST /api/claude-brain/votes/dispatch` with `providers=['claude-code']`
and `dryRun=false`. Cost is small but non-zero. To reproduce, run:

```bash
curl -X POST http://localhost:8788/api/claude-brain/votes/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"taskInput":"Evaluate the statement 2+2=4. Reply with one final-line JSON object only: {\"verdict\":\"pass\"|\"fail\",\"improvements_exhausted\":false,\"issues\":[],\"scores\":{\"groundedness\":0.0-1.0,\"specificity\":0.0-1.0}}","providers":["claude-code"],"cwd":"<octogent-repo>"}'
```
