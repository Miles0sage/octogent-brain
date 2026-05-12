# codeagent-wrapper (vendored)

This directory vendors the `codeagent-wrapper` Go binary and source from the
upstream `mingrath/arena-workflow` repository, which is itself a redesigned
fork of `fengshao1227/ccg-workflow`. The vendor is **load-bearing** for
octogent's supervisor dispatchers when `ARGUED_USE_WRAPPER=1`.

## Provenance

- Upstream (live): https://github.com/mingrath/arena-workflow
- Upstream commit: `34c327387073ca0f7c7ad30c7453cf0403efbb88`
- Ancestor (deleted, suspended ~2026-04-08): https://github.com/fengshao1227/ccg-workflow
- Wrapper version baked in: `5.7.2` (per `main.go:version` constant)
- Vendored: 2026-05-13 by octogent maintainers

## Why vendored, not depended

The upstream `ccg-workflow` npm package (`registry.npmjs.org/ccg-workflow`)
is still owned by `fengli_1227` and ships the original v2.x code, not the
arena fork. There is no published npm distribution of the arena wrapper.
Cloning + binary-vendoring is the only way to consume the arena version
without forking the whole project.

A future upstream-tracking commit must update both the binary set under
`bin/` and the source mirror under `src/` together, and bump the pinned
commit SHA in this file.

## License

MIT, original copyright held by `fengshao1227`. See `LICENSE` adjacent.

The arena fork preserves the original MIT copyright header and adds no
additional license terms. octogent's wider Apache-2 / MIT license terms
do not apply to this directory — `vendor/codeagent-wrapper/` is governed
by its own LICENSE file.

## What it does (so callers don't have to read the Go)

- Spawns one of three AI CLIs — `codex` / `claude` / `gemini` — as a
  subprocess with a structured stdin payload.
- Parses three vendor-specific streaming JSON formats into one unified
  event stream (`src/parser.go:1`).
- Returns the final assistant message + session id on stdout, plus
  structured progress events on stderr.
- Session reuse via `resume <session_id> <task>` re-enters a prior
  conversation without re-warming context.
- Exit codes: `0` ok, `1` general failure, `124` timeout, `127` backend
  binary not found.

## Supported on this vendor

- Linux x86_64 (`codeagent-wrapper-linux-amd64`, 6.3 MB)
- Linux arm64 (`codeagent-wrapper-linux-arm64`, 5.9 MB)
- macOS arm64 (`codeagent-wrapper-darwin-arm64`, 6.0 MB)
- macOS x86_64 (`codeagent-wrapper-darwin-amd64`, 6.4 MB)

Windows binaries from upstream are intentionally omitted — octogent is
not Windows-tested. To regenerate: `cd src && bash build-all.sh`.

## Not supported

- `aider` is not a wrapper-backed CLI. octogent's aider dispatcher stays
  on the native Node `spawn` path because aider does not stream JSON
  events in a wrapper-compatible shape.

## Update protocol

When pulling a newer arena commit:

1. `cd /tmp && rm -rf arena-workflow && gh repo clone mingrath/arena-workflow`
2. Run `bash vendor/codeagent-wrapper/src/build-all.sh` (or copy upstream
   `bin/` if upstream rebuilt). Confirm `--version` advanced.
3. Replace `vendor/codeagent-wrapper/{bin,src,LICENSE}` wholesale.
4. Update the pinned commit SHA at the top of this file.
5. Re-run `pnpm --filter @octogent/supervisor test` — the wrapper-runner
   parity tests assert the unified event shape; a wrapper bump that
   changes the JSON event vocabulary will trip them.
