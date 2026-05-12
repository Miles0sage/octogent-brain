# Changelog

All notable changes to the `@octogent/core` and `@octogent/supervisor` packages
in this repository are documented here. This project adheres to
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Deferred to v0.2.0

- **Cost-cap enforcement.** Per-run and per-vote budget caps that hard-stop the
  dispatcher when a cumulative dollar-spend threshold is crossed. Design spec
  at [`docs/superpowers/specs/2026-05-12-cost-cap-design.md`](docs/superpowers/specs/2026-05-12-cost-cap-design.md).

## [0.1.0] - 2026-05-12

Initial public release of the Mechanical Supervision substrate.

### Added

- **`@octogent/core`** — framework-agnostic domain types, the `verdict-gate`
  schema validator, and the `review-fix-loop` driver. Pure TypeScript with no
  I/O surface, so it composes cleanly into any host runtime.
- **`@octogent/supervisor`** — the orchestration layer on top of
  `@octogent/core`:
  - **Cross-CLI dispatcher** that drives four coding agents over their native
    transports: `aider` (stdio), `claude-code` (stdio), `codex` (pty), and
    `gemini-cli` (stdio).
  - **Verdict-gate** that parses reviewer JSON, enforces a strict schema, and
    catches rubber-stamp passes (a "looks good" verdict with no concrete
    `issues[]` evidence is rejected and re-iterated).
  - **Cross-vendor voting** via `tallyVotes`, with three configurable decision
    modes: `consensus`, `strong-reject`, and `qualified-majority`. Lets you
    fan out the same change to two or more vendors and only ship when they
    agree (or veto when any one strongly objects).
  - **Review-fix-loop** that re-prompts the writer with the reviewer's
    issues until the gate passes or the configured iteration cap is hit.
- **Test suite** — 86 tests across `@octogent/core` and `@octogent/supervisor`
  covering schema validation, voting tallies, dispatcher framing, and the
  end-to-end review-fix loop.
- **License** — both packages ship under the MIT license, matching the parent
  repository.

### Fixed

- **L3 audit fixes** — pre-v0.1.0 stabilization sweep covering verdict-gate
  edge cases (empty `issues[]`, malformed JSON, schema-violating reviewer
  payloads) and dispatcher framing for the four CLI transports.
- **Codex-2 audit fixes** — second-pass review of dispatcher I/O,
  cross-vendor voting tie-breaks, and review-fix-loop termination conditions.

### Notes

- This is a `0.x` release, so the public TypeScript API may shift between
  minor versions until `1.0.0`.
- Cost-cap enforcement is intentionally **not** part of `v0.1.0` — see the
  `Unreleased` section above for the deferred design spec.

[Unreleased]: https://github.com/Miles0sage/octogent-brain/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Miles0sage/octogent-brain/releases/tag/v0.1.0
