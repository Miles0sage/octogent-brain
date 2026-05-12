# Live smoke tests — captured 2026-05-12T04:48:39.669536

Run against http://localhost:8788 with the substrate at commit
$(git -C /root/octogent rev-parse HEAD).

Reproducer: `python3 /root/octogent/docs/evidence/2026-05-12-real-tests.py` (script below).

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
  "cwd": "/root/briefingdeck",
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
login on the host. The earlier in-session smoke (logged in conversation)
returned `winner=pass, duration_ms=16890, scores={groundedness:1, specificity:0.95}`
via `POST /api/claude-brain/votes/dispatch` with `providers=['claude-code']`
and `dryRun=false`. Cost ~\$0.005. To reproduce, run:

```bash
curl -X POST http://localhost:8788/api/claude-brain/votes/dispatch \
  -H 'Content-Type: application/json' \
  -d '{"taskInput":"Evaluate: 2+2=4. Emit final-line JSON.","providers":["claude-code"]}'
```
