# `@octogent/api` end-to-end tests

These tests boot the **real** `http.Server` returned by `createApiServer()`,
bind it to a random loopback port, and fire native `fetch` requests at
the endpoints. They prove the full boot-to-response round-trip
including:

- `host` / `origin` header gating,
- CORS layering,
- the bearer-token / rate-limit middleware in front of gated routes,
- `server.close()` teardown without leaked sockets.

This is distinct from the handler-level tests in `apps/api/tests/*.test.ts`,
which stub `IncomingMessage` / `ServerResponse` and exercise route logic
in isolation. The handler-level suite catches branch coverage on each
route file; the e2e suite catches regressions that only surface when the
full pipeline is wired together (e.g. an auth check that works in
isolation but is unreachable behind a misordered handler list).

## Files

- `helpers.ts` — `bootApiServer({ env })` returns `{ baseUrl, close }`.
  Snapshots + restores env vars on `close()` so suites stay isolated.
- `server-boot.test.ts` — boot smoke + happy-path round-trips on a few
  unauthenticated endpoints + a 404 case + a teardown timing check.
- `claude-brain-endpoints.test.ts` — full sweep across every
  `/api/claude-brain/*` endpoint. Each gets a happy-path 200 + an
  error-path (405 / 400 / 404) assertion. The endpoint inventory is
  pinned at the top of the file — keep it aligned with
  `apps/api/src/createApiServer/requestHandler.ts` `API_ROUTE_MAP`.
- `auth-gate.test.ts` — `OCTOGENT_API_KEY` enforcement on the gated
  routes (`/votes/dispatch`, `/drivers/dispatch`, `/cost-cap`,
  `/cost-cap/audit`). Covers Bearer, `X-Octogent-Token`, query-token
  (negative), and the 30 req/min rate limit.

## Run

```bash
pnpm --filter @octogent/api test                       # full suite
pnpm --filter @octogent/api exec vitest run tests/e2e/ # e2e only
```

Zero new dependencies — native `fetch` (Node 18+) and the existing
`http.Server` from `createApiServer`.

## Flakiness notes

- **Port binding**: every test boots on `0.0.0.0:0` and reads
  `server.address().port`. No fixed-port races.
- **Rate limit suite**: `auth-gate.test.ts` fires 30 successful
  requests in a tight loop on a single test. On a heavily loaded CI
  runner the per-test timeout can be tight; bump `vitest`'s
  `testTimeout` if needed.
- **State isolation**: every test calls `resetAuthState()` (rate-limit
  bucket) and `resetCostCapState()` (spend ring + daily totals) in
  both `beforeEach` and `afterEach`. Env vars are snapshotted on boot
  and restored on `close()`.
- **Tmp dirs**: each booted server gets its own `mkdtempSync` workspace
  that is removed on `close()`. Failure to clean up is non-fatal but
  may leave `/tmp/octogent-e2e-*` directories behind.

## When you add a new `/api/claude-brain/*` endpoint

1. Add it to `CLAUDE_BRAIN_ENDPOINTS` in `claude-brain-endpoints.test.ts`.
2. Write at least one happy-path test + one error-path test for it
   there.
3. If it's auth-gated, add Bearer / X-Octogent-Token / missing-header
   coverage in `auth-gate.test.ts`.

The boot-smoke test (`server-boot.test.ts`) deliberately only exercises
a handful of endpoints — it's a "did the server come up?" gate, not a
coverage layer.
