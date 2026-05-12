# Production-safe deployment

This guide walks an operator from `pnpm install` to a safely-exposed Octogent
dashboard. It complements the [Local development](../../README.md#local-development)
section in the README — that flow is for a single developer on their laptop;
this one is for anything reachable from outside `127.0.0.1`.

Threat model and the full bearer-token contract live in
[`./security.md`](./security.md) (Lane B's deliverable, shipped alongside
this guide). Default to the most restrictive option described here and
treat anything not on this page as out of scope for v0.2.

## 1. TL;DR

- `pnpm install && pnpm build` on Node 22+, then run `bin/octogent`.
- Generate `OCTOGENT_API_KEY` (≥32 random bytes), keep `HOST=127.0.0.1`,
  and put the dashboard behind a reverse proxy that terminates TLS.
- Set the cost caps explicitly. Defaults are conservative; they are not
  a substitute for thinking about your tolerance.

Solo-dev VPS: ~30 minutes. Small team behind a proxy: ~90 minutes
(allowlist, log rotation, staging cap-fire test). Multi-tenant:
see section 2.4 — Octogent is not built for it in v0.2.

## 2. Deployment targets

### 2.1 Local development

The README's [Local development](../../README.md#local-development) section
covers laptop / single-user development. It uses `pnpm dev`, binds
`127.0.0.1:8787`, and skips the guardrails below because no remote address
can reach the process. Do not deploy a `pnpm dev` process behind a reverse
proxy — the dev server exposes Vite tooling endpoints that should stay on
loopback.

```bash
pnpm install
pnpm dev
```

### 2.2 Solo dev VPS

Single-user pattern: you, on a VPS, want the dashboard reachable from your
laptop's IP without a reverse proxy. Set `OCTOGENT_ALLOW_REMOTE_ACCESS=1`
(the same flag that widens the bearer-auth gate, so it cannot be set by
accident) and bind to `0.0.0.0`. Bearer auth in
[`security.ts`](../../apps/api/src/createApiServer/security.ts) still
applies when `OCTOGENT_API_KEY` is set; without it, the server warns at
startup and proceeds unauthenticated.

Use this only when you ARE the LAN — single user, IP-restricted firewall.
The moment a second human needs access, move to section 2.3.

```bash
export OCTOGENT_ALLOW_REMOTE_ACCESS=1
export OCTOGENT_API_KEY="$(openssl rand -hex 32)"
export HOST=0.0.0.0
export PORT=8787
node /opt/octogent/bin/octogent
```

Open the dashboard with `?octogent_token=<key>` once; the UI stores it in
session storage. Never paste the key into chat, never commit it, and
rotate it whenever you've shared the URL with someone you no longer
trust.

### 2.3 Small team (2–10 devs) behind a reverse proxy

Recommended production pattern. Octogent listens on `127.0.0.1:8787`;
Caddy or nginx terminates TLS in front of it. The bearer token
(`OCTOGENT_API_KEY`) is **mandatory** — without it, proxy connections
(which appear as `127.0.0.1` to the API) would sail through
unauthenticated. The proxy also gets an IP allowlist as
defense-in-depth.

```bash
# On the host:
export HOST=127.0.0.1
export PORT=8787
export OCTOGENT_API_KEY="$(openssl rand -hex 32)"
export OCTOGENT_AUDIT_LOG=/var/log/octogent/audit.jsonl
export OCTOGENT_TIER=small-co
export OCTOGENT_PER_DAY_USD=50
node /opt/octogent/bin/octogent
```

Templates for the proxy itself are in section 4.

### 2.4 Enterprise / multi-tenant

**Do not deploy v0.2 as a multi-tenant service.** There is no per-tenant
isolation: cost caps share an in-memory map, the audit log is a single
JSONL file, and bearer auth is a single shared secret. Two tenants
sharing one instance can read each other's vote transcripts and exhaust
each other's daily cap.

For enterprise, run one Octogent process **per tenant** with a queue or
orchestrator in front. Each tenant gets its own `OCTOGENT_API_KEY`,
audit log, and cost-cap budget. Terminate auth at the orchestrator and
route to per-tenant backends — Octogent should not be the multi-tenant
boundary. OAuth / SSO, leader election, and horizontal scaling are out
of scope for v0.2 (section 8).

## 3. Environment variables

The table below covers every `OCTOGENT_*` flag that affects deployment.
Defaults verified against `apps/api/src/server.ts`,
`apps/api/src/cost-cap.ts`, and
`apps/api/src/createApiServer/security.ts` on 2026-05-12.

| Variable | Default | Required for | What it does | Security implication |
|---|---|---|---|---|
| `PORT` / `OCTOGENT_API_PORT` | `8787` | optional | TCP port. Validated 1–65535 at startup. | Use ≥ 1024; never run as root. |
| `HOST` | `127.0.0.1` | optional | Bind interface. | Keep loopback unless fronted by a proxy (section 4) or in solo-dev mode (section 2.2). |
| `OCTOGENT_API_KEY` | unset | **production** | Bearer token for state-changing `/api/claude-brain/*` calls. `timingSafeEqual` compared. | When unset + remote access enabled, dashboard is unauthenticated (server warns). Generate with `openssl rand -hex 32`. |
| `OCTOGENT_ALLOW_REMOTE_ACCESS` | `0` | solo dev VPS only | Allows non-loopback IPs when `OCTOGENT_API_KEY` is unset; widens CORS/Host checks. | Single-user dev only. Never in production. See [`security.md`](./security.md). |
| `OCTOGENT_AUDIT_LOG` | `/tmp/octogent-audit.jsonl` | optional | Append-only JSONL of cost-cap fires + vote dispatches. | Rotate (section 7). `/tmp` is wiped on reboot — move to `/var/log/octogent/`. |
| `OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD` | unset (off) | optional | When `1`, audit entries include full `taskInput` / `rubric` / `prompt` fields. Default redacts them to `<redacted N chars>` envelopes. | PII risk. Enable only when legally required (e.g. SOC2 evidence on an isolated host). See [`security.md`](./security.md). |
| `OCTOGENT_TIER` | `free` | optional | `free` or `small-co`. `small-co` unlocks the Spend subtab. | Cosmetic; no auth impact. |
| `OCTOGENT_PER_DISPATCH_USD` | `0.5` | recommended | Per-call ceiling. Refused with HTTP 402 before subprocess spawn. | Tighten below your tolerance; no refunds after the call lands. |
| `OCTOGENT_PER_SESSION_USD` | `5.0` | recommended | Per-session cumulative ceiling. | Bounds compromised-session blast radius. |
| `OCTOGENT_PER_DAY_USD` | `20.0` | recommended | Per-UTC-day ceiling across all sessions. Resets at 00:00 UTC. | Bounds compromised-host blast radius. |
| `CLAUDE_BRAIN_ROOT` | `/root/claude-brain` | claude-brain only | Brain panel daemons/skills root. | Read-only. See [`CLAUDE_BRAIN_INTEGRATION.md`](../../CLAUDE_BRAIN_INTEGRATION.md). |
| `CLAUDE_USER_ROOT` | `/root/.claude` | claude-brain only | User-level Claude state root. | Read-only, but path is exposed in API responses — do not point at sensitive trees. |
| `OCTOGENT_MAX_TERMINAL_SESSIONS` | `32` | optional | Live PTY session cap. | Lower on small VPS. |
| `OCTOGENT_NO_OPEN` | unset | optional | `1` suppresses browser auto-open. | Always set in headless deployments. |
| `OCTOGENT_WORKSPACE_CWD` | `process.cwd()` | optional | Override working directory. Existence-checked. | Service user must read/write. |
| `OCTOGENT_WEB_DIST_DIR` | auto-detected | optional | Override dashboard bundle path. Warns if missing. | Without it the UI is unavailable; API still runs. |
| `OCTOGENT_PROJECT_STATE_DIR` | `~/.octogent/projects/<id>/state/` | optional | Override runtime state dir. | Persistent disk only. |
| `OCTOGENT_PROMPTS_DIR` | bundled | optional | Override prompts dir. | Keep default unless forking the prompt set. |

Additional flags exist for debug logging (`OCTOGENT_VERBOSE_LOGS`,
`OCTOGENT_DEBUG_PTY_LOGS`, `OCTOGENT_DEBUG_PTY_LOG_DIR`), fixtures
(`OCTOGENT_FIXTURES_ROOT`, `OCTOGENT_PACKAGE_ROOT`), the X usage
endpoint (`OCTOGENT_X_API_BASE_URL`, `OCTOGENT_X_USAGE_ENDPOINT_PATH`),
the CLI client (`OCTOGENT_API_BASE` / `OCTOGENT_API_ORIGIN` /
`OCTOGENT_SESSION_ID`), and the persistence root (`OCTOGENT_DIR`).
These are developer / client affordances; do not set them in
production server environments.

## 4. Reverse-proxy templates

Octogent has **no built-in TLS**. Terminate at the proxy.

### 4.1 Caddy (recommended)

Caddy provisions Let's Encrypt automatically and passes WebSocket
upgrades through without explicit configuration.

```
app.example.com {
    reverse_proxy 127.0.0.1:8787 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }

    # Optional: IP allowlist on top of the bearer token.
    @notallowed not remote_ip 203.0.113.0/24 198.51.100.0/24
    respond @notallowed 403
}
```

The `header_up Host {host}` line keeps Octogent's host-header
validation in
[`security.ts`](../../apps/api/src/createApiServer/security.ts) from
rejecting the request. Caddy forwards `Authorization: Bearer <token>`
unmodified by default.

### 4.2 nginx

```
server {
    server_name app.example.com;
    listen 443 ssl http2;

    # certbot-managed
    ssl_certificate /etc/letsencrypt/live/app.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/app.example.com/privkey.pem;

    # IP allowlist (defense-in-depth on top of bearer token).
    allow 203.0.113.0/24;
    allow 198.51.100.0/24;
    deny all;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;

        # WebSocket upgrade pass-through.
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Preserve auth + identity.
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Authorization $http_authorization;

        # Long-running vote dispatches.
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}

server {
    listen 80;
    server_name app.example.com;
    return 301 https://$host$request_uri;
}
```

`proxy_read_timeout 300s` matters: cross-vendor votes spawn three CLI
subprocesses; the slowest voter dictates response time. The nginx
default 60s is too tight.

Terminate TLS at the proxy. The server ships no certificate-handling
code so it cannot be misconfigured into serving plaintext on what looks
like an HTTPS port.

## 5. systemd service unit

Save as `/etc/systemd/system/octogent.service`. Hardening directives
are the minimum that play well with `node-pty`, the audit log, and the
`.octogent/` scaffold.

```
[Unit]
Description=Octogent — cross-vendor AI coding agent supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=octogent
Group=octogent
WorkingDirectory=/opt/octogent
EnvironmentFile=/etc/octogent/octogent.env
ExecStart=/usr/bin/node /opt/octogent/bin/octogent
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/octogent /var/log/octogent
LockPersonality=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
```

`EnvironmentFile=/etc/octogent/octogent.env` (mode `0640`, owned by
`root:octogent`) holds the secrets:

```
PORT=8787
HOST=127.0.0.1
OCTOGENT_API_KEY=replace-with-output-of-openssl-rand-hex-32
OCTOGENT_AUDIT_LOG=/var/log/octogent/audit.jsonl
OCTOGENT_TIER=small-co
OCTOGENT_PER_DISPATCH_USD=0.5
OCTOGENT_PER_SESSION_USD=5
OCTOGENT_PER_DAY_USD=20
OCTOGENT_NO_OPEN=1
```

Paths above are illustrative; adjust for your distro. The `octogent`
user should own `/var/lib/octogent` and `/var/log/octogent`, and nothing
else.

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now octogent.service
journalctl -u octogent -f
```

## 6. Pre-flight checklist

Tick before going live.

- [ ] `OCTOGENT_API_KEY` set, ≥32 random bytes (`openssl rand -hex 32`),
      not committed.
- [ ] `HOST=127.0.0.1`. Bind `0.0.0.0` only behind a proxy or in
      solo-dev mode.
- [ ] Reverse proxy terminates TLS with a valid (not self-signed) cert.
- [ ] Proxy passes `Upgrade` + `Connection` headers — the dashboard's
      WebSocket transport breaks silently without them.
- [ ] `OCTOGENT_ALLOW_REMOTE_ACCESS` is **not** set.
- [ ] `OCTOGENT_AUDIT_LOG` points to monitored disk and is rotated
      (section 7). Default `/tmp/octogent-audit.jsonl` is wiped on reboot.
- [ ] `OCTOGENT_AUDIT_LOG_INCLUDE_PAYLOAD` is **not** set unless
      legally required — payloads may contain credentials or PII.
- [ ] All three cost caps are set explicitly and per-day is below your
      incident-budget threshold.
- [ ] Node ≥ `22.0.0` on the deploy host (`node --version`); matches
      `engines.node` in the root `package.json`.
- [ ] Process manager restarts on failure with bounded retry
      (`Restart=on-failure` + `RestartSec=5` floor).
- [ ] You have triggered a cap-fire in staging
      (`OCTOGENT_PER_DISPATCH_USD=0.0001`) and confirmed the dashboard
      refusal AND audit-log capture.
- [ ] You have run an end-to-end cross-vendor vote in staging
      (Claude + Codex + Gemini) and confirmed the tally returns.
- [ ] IP allowlist configured at the proxy — bearer auth is a single
      shared secret; the allowlist bounds leak blast radius.

## 7. Operational notes

**Log rotation.** The audit log is append-only JSONL. Reasonable
`logrotate.d`:

```
/var/log/octogent/audit.jsonl {
    daily
    rotate 30
    compress
    delaycompress
    missingok
    notifempty
    create 0640 octogent octogent
    copytruncate
}
```

`copytruncate` matters: Octogent holds the file handle open, so
rename-based rotation would silently route new writes to the rotated
file. Reopen-on-SIGHUP is a roadmap item.

**Rotating `OCTOGENT_API_KEY`.** Stop the service, edit
`/etc/octogent/octogent.env`, start it again. No hot reload in v0.2 —
in-flight requests will 401 on their next call, which is the intended
behavior for "the old key is dead right now."

```bash
systemctl stop octogent.service
# edit /etc/octogent/octogent.env
systemctl start octogent.service
```

**Recovering from a runaway dispatch.** If a vote stalls,
`systemctl stop octogent.service` kills the parent and the kernel
reaps the children. Restart clears in-memory rate-limit and cost-cap
state (per
[`security.ts`](../../apps/api/src/createApiServer/security.ts) and
[`cost-cap.ts`](../../apps/api/src/cost-cap.ts)), so a forced restart
also resets per-session cap counters. Desired during incident response;
footgun during normal operation.

**Scaling.** v0.2 is single-instance only. Cost-cap and rate-limit
state are per-process in memory — two instances behind a load balancer
double your effective cap and halve your rate limit per IP. Run
separate per-tenant instances (section 2.4) and aggregate at the
orchestration layer.

## 8. What this guide does NOT cover

Out of scope for v0.2:

- **Multi-region deployment** — no replication, leader election, or
  cross-region audit-log aggregation.
- **Database-backed audit log** — JSONL on disk only, no SQLite/Postgres.
- **Authentication beyond bearer** — no OAuth, SSO, or per-user RBAC.
  OAuth / SSO is on the roadmap; see the README's
  [Status / roadmap](../../README.md#status--roadmap).
- **Cluster mode / leader election** — single-process only.
- **Hot config reload** — restart to pick up env changes.
- **Threat model and security contract** — in
  [`./security.md`](./security.md) (Lane B). Read that before exposing
  Octogent to any traffic you do not control.

The v0.2 launch posture is "small teams behind a reverse proxy";
everything else is a research problem.
