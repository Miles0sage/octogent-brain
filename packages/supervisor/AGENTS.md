# Supervisor Guidelines

## Ownership
- `packages/supervisor` holds the publish-ready npm substrate: verdict-watcher (stateful stdout scanner), cross-CLI dispatcher (`dispatchTask`), routing.json loader (`loadRoutingConfig`), and the public re-export surface for `@octogent/core` types.
- This package is consumed by `apps/api` and is intended to also be `npm install @octogent/supervisor`-able for third parties.

## Boundaries
- Node-only is allowed here (`node:child_process`, `node:crypto`, `node:fs`, `node:os`, `node:path`). Distinct from `@octogent/core`, which forbids process execution and filesystem.
- No React, no HTTP server framework, no PTY. HTTP routes belong in `apps/api`.
- Public exports stay framework-agnostic so consumers can use just the watcher, just the dispatcher, or both.

## Change Discipline
- Public re-export surface in `src/index.ts` is API contract. Adding exports is fine; removing or renaming requires a major version bump.
- The verdict JSON shape (`ReviewerVerdict` from `@octogent/core`) is also API contract — same rule.
- Keep watcher pure (no I/O), keep dispatcher Node-only, keep routing loader filesystem-bound but transport-agnostic.

## Distribution
- `package.json#files` controls what ships on `npm publish`. Currently: `src/`, `README.md`, `LICENSE`. Test files do not ship.
- Bump `version` per semver before any publish.
