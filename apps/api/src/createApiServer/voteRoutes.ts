// Cross-vendor voting route — the moat.
//
// Anthropic structurally cannot ship cross-vendor routing because it
// cannibalizes Claude API revenue. The defensible 60-day play is "ship the
// same task to N CLIs in parallel + pick winner mechanically by consensus."
// This HTTP route is the I/O shell around the pure tallyVotes primitive
// in @octogent/supervisor.
//
// Wire: POST /api/claude-brain/votes/dispatch
// Body: { taskInput: string, taskType?: string, providers?: string[], dryRun?: boolean }
//
// Reuses the existing dispatcher (DO NOT reimplement subprocess plumbing).
// Each dispatch returns stdout/stderr events; we concatenate stdout and run
// parseReviewerVerdict to extract a ReviewerVerdict per voter, then tally.

import { randomUUID } from "node:crypto";

import {
  isTerminalAgentProvider,
  parseReviewerVerdict,
  type RoutingConfig,
  type TerminalAgentProvider,
} from "@octogent/core";
import {
  DEFAULT_VOTE_CONFIG,
  dispatchTask,
  loadRoutingConfig,
  tallyVotes,
  type VoterVerdict,
} from "@octogent/supervisor";

// L3 audit M3 (2026-05-12): apply the identical cwd allowlist policy
// driverRoutes uses. Both endpoints accept a cwd field and both spawn
// subprocesses there, so they share the same threat model.
import { isCwdAllowed } from "./driverRoutes";
import type { ApiRouteHandler } from "./routeHelpers";
import {
  readJsonBodyOrWriteError,
  writeJson,
  writeMethodNotAllowed,
} from "./routeHelpers";
import { checkAuthorizedRequest } from "./security";

const VOTE_PATH = "/api/claude-brain/votes/dispatch";

// L3 audit r2 H3 (2026-05-12): fan-out cap. Any single request that
// fans out to more than this many voters spawns one subprocess per
// voter — even with auth in place, an unbounded list is an
// amplification multiplier (one POST -> N spawns). 8 is enough for
// every realistic cross-vendor consensus pool today (4-vendor matrix
// plus future headroom) and small enough that the per-request worst
// case stays bounded.
const MAX_VOTERS = 8;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

// Pick the evaluator-capable drivers from a routing config. A driver
// qualifies if its capabilities include "evaluator" or "all". This mirrors
// the Generator-Evaluator separation: the writer-only drivers (e.g. aider)
// and intel-only drivers (e.g. gemini-cli) should not vote on verdicts.
const selectDefaultProviders = (
  config: RoutingConfig,
): ReadonlyArray<TerminalAgentProvider> =>
  config.drivers
    .filter((d) =>
      d.capabilities.some((c) => c === "evaluator" || c === "all"),
    )
    .map((d) => d.provider);

// Concatenate stdout text from a dispatch's event stream into a single
// string suitable for parseReviewerVerdict + suitable for human
// consumption in voter.raw_output. Stderr is intentionally excluded —
// the verdict JSON contract is on stdout (the dispatcher's stdio
// transport routes the model's response there).
//
// L3 audit r2 L3 (2026-05-12): preserve event boundaries by separating
// chunks with a newline. parseReviewerVerdict walks the entire buffer
// for balanced JSON objects, so inserting newlines does not change
// parse behaviour. It does make raw_output legible when streamed back
// to the client (dashboards / debugging).
const aggregateStdout = (
  events: ReadonlyArray<{ kind: string; data?: string }>,
): string =>
  events
    .filter((e): e is { kind: "stdout"; data: string } => e.kind === "stdout")
    .map((e) => e.data)
    .join("\n");

export const handleVoteDispatchRoute: ApiRouteHandler = async (
  { request, response, requestUrl, corsOrigin },
  { workspaceCwd },
) => {
  if (requestUrl.pathname !== VOTE_PATH) {
    return false;
  }
  if (request.method !== "POST") {
    writeMethodNotAllowed(response, corsOrigin);
    return true;
  }

  // L3 audit r2 C1 (2026-05-12): bearer-token / loopback gate + per-IP
  // rate limit. The route must reject before reading the body so a
  // hostile client cannot exhaust JSON parsing budget pre-auth.
  const auth = checkAuthorizedRequest(request);
  if (!auth.ok) {
    writeJson(response, auth.status, { error: auth.reason }, corsOrigin);
    return true;
  }

  const bodyResult = await readJsonBodyOrWriteError(request, response, corsOrigin);
  if (!bodyResult.ok) return true;

  const body = bodyResult.payload;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    writeJson(response, 400, { error: "body must be a JSON object" }, corsOrigin);
    return true;
  }

  const fields = body as Record<string, unknown>;
  if (!isNonEmptyString(fields.taskInput)) {
    writeJson(response, 400, { error: "taskInput is required" }, corsOrigin);
    return true;
  }

  const taskType = isNonEmptyString(fields.taskType) ? fields.taskType : "verify";
  const cwd = isNonEmptyString(fields.cwd) ? fields.cwd : workspaceCwd;
  // L3 audit M3 (2026-05-12): same allowlist driverRoutes uses. Refuse
  // request-supplied cwds outside the workspace + tentacle worktrees.
  if (!isCwdAllowed(cwd, workspaceCwd)) {
    writeJson(
      response,
      400,
      { error: "cwd not within allowed workspace" },
      corsOrigin,
    );
    return true;
  }
  const dryRun = fields.dryRun === true;

  const loaded = loadRoutingConfig();
  if (!loaded.ok) {
    writeJson(
      response,
      500,
      { error: "routing config invalid", detail: loaded },
      corsOrigin,
    );
    return true;
  }
  const config: RoutingConfig = loaded.config;

  // Resolve which providers to fan out to. Explicit list wins; otherwise
  // every evaluator-capable driver in the routing config votes.
  //
  // L3 audit r2 H3 (2026-05-12): cap the fan-out at MAX_VOTERS and dedup
  // the list before dispatching. Without these guards one request could
  // spawn N subprocesses (DoS amplifier).
  let providers: ReadonlyArray<TerminalAgentProvider>;
  if (isStringArray(fields.providers)) {
    const requested = fields.providers;
    if (requested.length === 0) {
      writeJson(
        response,
        400,
        { error: "providers must be a non-empty array" },
        corsOrigin,
      );
      return true;
    }
    if (requested.length > MAX_VOTERS) {
      writeJson(
        response,
        400,
        { error: `providers list exceeds MAX_VOTERS=${MAX_VOTERS}` },
        corsOrigin,
      );
      return true;
    }
    const seen = new Set<TerminalAgentProvider>();
    const validated: TerminalAgentProvider[] = [];
    for (const p of requested) {
      if (!isTerminalAgentProvider(p)) {
        writeJson(
          response,
          400,
          { error: `providers[*] must be a known TerminalAgentProvider; got '${p}'` },
          corsOrigin,
        );
        return true;
      }
      if (seen.has(p)) continue;
      seen.add(p);
      validated.push(p);
    }
    providers = validated;
  } else {
    // Default selection is still capped — a hostile routing.json could
    // declare 100 evaluator-capable drivers; the cap saves us.
    providers = selectDefaultProviders(config).slice(0, MAX_VOTERS);
  }

  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();

  // Per-provider dispatch in parallel. The dispatcher already handles
  // health probes + timeouts + binary-on-PATH safety internally — we just
  // hand it taskType + taskInput + cwd + dryRun.
  //
  // Picker note: dispatchTask uses `taskType` to find the routing rule and
  // its preferred provider. To force a specific provider per voter, we
  // synthesize a single-driver, single-rule config that pins that provider
  // as the preferred for the task. This keeps the dispatcher's safety
  // checks intact without reaching into its internals.
  //
  // L3 audit r2 H3 (2026-05-12): wrap each voter in Promise.allSettled so
  // one voter's synchronous or asynchronous throw cannot reject the
  // whole tally. The rejected voter surfaces as an error voter; the
  // rest still tally.
  const settled = await Promise.allSettled(
    providers.map(async (provider) => {
      const driver = config.drivers.find((d) => d.provider === provider);
      if (!driver) {
        // Voter is unreachable — synthesize an error voter; tally treats
        // null verdicts as unparseable.
        return {
          provider,
          dispatch_id: randomUUID(),
          voter: {
            provider,
            verdict: null,
            raw_output: "",
            error: `provider '${provider}' not present in routing.json drivers`,
          } satisfies VoterVerdict,
        };
      }
      // Pin this provider as preferred for the task by building a scoped
      // config that contains only this driver and an override rule.
      const scopedConfig: RoutingConfig = {
        ...config,
        defaultProvider: provider,
        rules: [
          {
            taskType,
            preferred: provider,
            fallback: [],
            extraArgs:
              config.rules.find((r) => r.taskType === taskType)?.extraArgs ?? [],
          },
        ],
      };
      const result = await dispatchTask(scopedConfig, {
        taskType,
        taskInput: fields.taskInput as string,
        cwd,
        dryRun,
      });
      const stdoutText = aggregateStdout(result.events);
      const parsed = parseReviewerVerdict(stdoutText);
      return {
        provider,
        dispatch_id: result.dispatch_id,
        voter: {
          provider,
          verdict: parsed,
          raw_output: stdoutText,
          ...(result.health.healthy
            ? {}
            : { error: `health-failed: ${result.health.reason}` }),
        } satisfies VoterVerdict,
      };
    }),
  );

  const perVoter = settled.map((entry, idx) => {
    if (entry.status === "fulfilled") return entry.value;
    const provider = providers[idx] as TerminalAgentProvider;
    const message =
      entry.reason instanceof Error
        ? entry.reason.message
        : String(entry.reason);
    return {
      provider,
      dispatch_id: randomUUID(),
      voter: {
        provider,
        verdict: null,
        raw_output: "",
        error: `voter-exception: ${message}`,
      } satisfies VoterVerdict,
    };
  });

  const votes: VoterVerdict[] = perVoter.map((p) => p.voter);
  const dispatchIds = perVoter.map((p) => p.dispatch_id);
  const outcome = tallyVotes(votes, DEFAULT_VOTE_CONFIG);
  const durationMs = Date.now() - startedAt;

  writeJson(
    response,
    200,
    {
      vote_id: randomUUID(),
      outcome,
      dispatch_ids: dispatchIds,
      started_at_iso: startedAtIso,
      duration_ms: durationMs,
    },
    corsOrigin,
  );
  return true;
};
