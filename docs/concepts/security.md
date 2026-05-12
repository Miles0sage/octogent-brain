# Security

Octogent ships as a developer tool that orchestrates terminal AI agents
(claude-code, codex, gemini-cli, aider, …). It runs unprivileged on the
operator's host, binds an HTTP API + WebSocket terminals, and spawns
subprocesses to drive each agent. This page documents the threat model,
the defense-in-depth controls, and the explicit compliance posture.

## Audit (v0.2 launch blocker review, 2026-05-12)

The v0.2 launch review enumerated five remote-exposure gaps. All are
closed in commit `feat(security): redact audit log + rate-limit bucket
cap + insecure-bind warning`.

| #  | Severity | Gap                                                                                              | Fix                                                                                                                   | Status |
|----|----------|--------------------------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|--------|
| 1  | HIGH     | `OCTOGENT_ALLOW_REMOTE_ACCESS=1` + no API key let non-loopback callers complete WS upgrades.    | New `checkAuthorizedWsUpgrade` gate refuses non-loopback WS upgrades without `OCTOGENT_API_KEY`, regardless of flag.  | DONE   |
| 2  | MEDIUM   | `HOST=0.0.0.0` bind without `OCTOGENT_API_KEY` produced no stderr warning unless allow-remote=1. | `warnInsecureConfig(host, …)` warns on either insecure boot path; one-shot print latch prevents log spam.            | DONE   |
| 3  | HIGH     | `Access-Control-Allow-Origin` is wildcarded whenever `allowRemoteAccess=true`.                  | Documented trade-off; combined with WS hardening + stderr warning so the operator can't hit this path silently.       | DONE   |
| 4  | HIGH     | Audit log JSONL would leak `taskInput`/`rubric` contents (potential secret exfil).               | `redactAuditEntry` replaces those fields with `<redacted N chars>`; opt-in via `OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD=1`. | DONE   |
| 5  | MEDIUM   | `rateLimitBuckets` Map was unbounded → IP-rotation memory DoS.                                   | FIFO eviction of 1_000 oldest buckets when size > 10_000.                                                            | DONE   |

Regression coverage lives in `apps/api/tests/security.test.ts` (14
tests, all green).

## Environment flags that widen exposure

| Flag                                  | Default          | Effect                                                                                                |
|---------------------------------------|------------------|-------------------------------------------------------------------------------------------------------|
| `OCTOGENT_API_KEY`                    | (unset)          | When set, every gated route requires `Authorization: Bearer <key>` (or `X-Octogent-Token`, or `?octogent_token=`). |
| `OCTOGENT_ALLOW_REMOTE_ACCESS=1`      | (unset)          | When the API key is unset, lets non-loopback HTTP callers reach gated routes. WS upgrades are NOT widened by this flag. |
| `HOST`                                | `127.0.0.1`      | Bind address. Setting to `0.0.0.0` exposes the API to every interface. A stderr warning fires when this is combined with no API key. |
| `OCTOGENT_AUDIT_LOG`                  | `/tmp/octogent-audit.jsonl` | Path of the cost-cap audit JSONL. Redacted by default.                                          |
| `OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD=1`| (unset)          | Opt-in: write `taskInput`/`rubric`/`prompt` fields in the clear to the audit JSONL. Required only for SOC2-style evidence collection on an isolated host. |
| `OCTOGENT_TIER`                       | `free`           | Pricing tier; does not directly widen exposure but gates the Spend subtab + audit endpoint UI surface. |

## HTTP / WS attack surface

| Endpoint                                         | Method | Auth (when `OCTOGENT_API_KEY` set) | Notes |
|--------------------------------------------------|--------|------------------------------------|-------|
| `POST /api/claude-brain/votes/dispatch`          | POST   | Bearer header                      | Spawns ≤ `MAX_VOTERS=8` subprocesses. Cwd allowlist + cost-cap pre-flight. |
| `POST /api/claude-brain/drivers/dispatch`        | POST   | Bearer header                      | Single-driver dispatch. Same allowlist as voting. |
| `GET  /api/claude-brain/cost-cap`                | GET    | Bearer header                      | Returns cost-cap config + daily spend. |
| `GET  /api/claude-brain/cost-cap/audit`          | GET    | Bearer header                      | Last 100 audit entries (in-memory ring). |
| WebSocket upgrade (terminal PTYs)                | UPG    | Bearer header OR `?octogent_token=…` query parameter | **Stricter**: non-loopback callers always require an API key even when `OCTOGENT_ALLOW_REMOTE_ACCESS=1` is set. |
| All other `/api/claude-brain/*` reads             | GET    | None                               | Daemon status, driver list, usage summaries — read-only, no subprocess fan-out. |

Per-IP rate limit (30 req / 60 s) applies to every gated route and to
the WS upgrade gate. Buckets are FIFO-evicted at 10_000 entries.

## Threat model

Three personas drive the design:

**1. Malicious LAN tenant (shared dev VPS, hotel Wi-Fi, etc.)**
- Goal: ride a co-tenant's open Octogent dashboard.
- Mitigation: default bind is `127.0.0.1`. Cross-tenant access requires
  either an explicit `HOST=0.0.0.0` bind or
  `OCTOGENT_ALLOW_REMOTE_ACCESS=1`. Both paths print a one-line stderr
  warning when no API key is set.

**2. Internet attacker against `0.0.0.0`**
- Goal: reach the WS terminal PTY, drive subprocesses, exfil secrets.
- Mitigation: HTTP gate refuses non-loopback callers without
  `OCTOGENT_API_KEY` unless the operator opted in via
  `OCTOGENT_ALLOW_REMOTE_ACCESS=1`. The WS gate is stricter: it ALWAYS
  refuses non-loopback callers without `OCTOGENT_API_KEY`, regardless
  of the allow-remote flag, because WS hands the caller a persistent
  bidirectional channel into the spawned PTY.

**3. Supply-chain attacker via `routing.json`**
- Goal: get Octogent to spawn `/bin/sh` or a malicious binary.
- Mitigation: `RoutingConfig` validation (`isDriverSpec`) rejects
  unknown providers and structurally bad shapes at load time.
  Subprocess invocation goes through the `dispatchTask` shim, which
  resolves binaries from `PATH` and enforces a per-driver env allowlist
  (see commit `6747009`).

## Defense in depth

1. **Default-deny bind** — listens on loopback unless the operator
   sets `HOST`. The `octogent serve` boot path warns on stderr when it
   binds a non-loopback address without an API key.

2. **Bearer-token auth** — `OCTOGENT_API_KEY` enforced via
   `timingSafeEqual`. Three transport options (Authorization header,
   `X-Octogent-Token` header, `?octogent_token=` query parameter for
   dashboard URLs and WS upgrades).

3. **Per-IP rate limit** — 30 req / 60 s sliding window in
   `rateLimitBuckets`. Capped at 10_000 distinct IPs; FIFO eviction in
   batches of 1_000 once the cap is exceeded. Limits the spawn ceiling
   to ≤ 30 × `MAX_VOTERS` (240) processes/minute/IP.

4. **CORS** — origin echo for loopback only by default;
   `allowRemoteAccess=true` widens this to permit dashboard URLs from
   any origin. Operators using `allow-remote` are expected to be on a
   single-user VPS where CORS is moot. For multi-user deployments,
   terminate TLS at a reverse proxy and front Octogent with a real
   origin policy.

5. **Audit-log redaction** — `redactAuditEntry` strips
   `taskInput` / `rubric` / `prompt` fields from every JSONL line
   before append. Only `<redacted N chars>` placeholders survive.
   Opt-in via `OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD=1` for SOC2 evidence
   collection on a fully isolated host. The cost / event metadata
   (providers, dollar amounts, cap-fire reason, timestamps) is always
   recorded — the redaction concerns content, not envelope.

6. **`RoutingConfig` validation** — `isDriverSpec` shape check before
   the dispatcher will spawn anything. Unknown providers, malformed
   capability arrays, and non-string binary paths all fail closed.

7. **Cwd allowlist** — both `/votes/dispatch` and `/drivers/dispatch`
   refuse request-supplied `cwd` paths outside the workspace + known
   tentacle worktrees.

8. **Fan-out cap** — `MAX_VOTERS=8` caps the per-request subprocess
   amplification, so even an authenticated attacker with a valid key
   cannot drive an unbounded fork-bomb.

## Default-deny stance

Octogent's posture is: **everything refuses unless explicit opt-in**.

- API binds loopback unless `HOST` is set.
- Gated routes refuse non-loopback unless `OCTOGENT_API_KEY` is set OR
  the operator opted in via `OCTOGENT_ALLOW_REMOTE_ACCESS=1`.
- WS upgrades refuse non-loopback unless `OCTOGENT_API_KEY` is set
  (the allow-remote flag does NOT widen WS).
- Audit log redacts payload unless
  `OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD=1`.

The single concession to dev ergonomics is that the operator's own
loopback never has to present credentials. Production = set the API
key.

## Compliance posture

Octogent is **a developer tool for routing AI-agent traffic**. It is
NOT certified for PCI, HIPAA, FedRAMP, or similar regulated workloads,
and does not aim to be. Concretely:

- **No encryption at rest.** Local session state, cost-cap audit logs,
  routing configs, and prompt history live as plain files in
  `$OCTOGENT_PROJECT_STATE_DIR` / `/tmp/octogent-audit.jsonl`. Disk
  encryption (LUKS, FileVault) is the operator's responsibility.

- **No native TLS.** The API speaks plain HTTP / WS. Operators
  exposing Octogent beyond loopback must terminate TLS at a reverse
  proxy (nginx, Caddy, Cloudflare Tunnel) and forward
  `Authorization: Bearer …` upstream.

- **No tamper-resistant audit trail.** The JSONL audit log is
  append-only by convention but is not signed, chained, or replicated.
  An attacker with write access to the audit path can edit it.
  Operators who need real audit assurance should ship the JSONL to a
  log-aggregation system (Loki, Datadog, ELK) and treat the local
  file as a buffer, not as evidence of record.

- **No identity / role model.** A single `OCTOGENT_API_KEY` is the only
  identity Octogent knows. Multi-tenant deployments need an upstream
  authn/authz layer (oauth2-proxy, Pomerium, internal IdP) that
  presents a single shared key downstream.

- **Not a sandbox.** Spawned agent subprocesses inherit the operator's
  uid/gid, file-system access, and network access. The cwd allowlist
  and routing validation limit the configuration surface; they do not
  jail the agent at runtime. Run Octogent inside a container or VM if
  the agents you route to are untrusted.

If your workload has a real compliance need, deploy Octogent on a
hardened host inside a regulated boundary — don't expect Octogent
itself to provide that boundary.
