// @octogent/supervisor — Mechanical-supervision substrate for autonomous
// coding agents. Wraps Aider / Claude Code / Codex / Gemini CLI behind a
// single dispatcher with a verdict-gate that catches rubber-stamp passes
// and forces re-iteration.
//
// Public re-exports — every consumer gets the verdict-gate + review-fix-
// loop logic from @octogent/core, plus the supervisor-owned watcher and
// dispatcher.

export {
  DEFAULT_GATE_CONFIG,
  DEFAULT_REVIEW_FIX_LOOP_CONFIG,
  DEFAULT_ROUTING_CONFIG,
  decideNext,
  evaluateVerdict,
  isDriverSpec,
  isTerminalAgentProvider,
  parseReviewerVerdict,
  pickDriverForTask,
  validateRoutingConfig,
  type DriverCapability,
  type DriverSpec,
  type DriverTransport,
  type GateConfig,
  type GateDecision,
  type LoopDecision,
  type LoopIteration,
  type LoopOutcome,
  type ReviewFixLoopConfig,
  type ReviewerVerdict,
  type RoutingConfig,
  type RoutingConfigValidationError,
  type RoutingRule,
  type TerminalAgentProvider,
  type ValidateChartResult,
  type ValidateRoutingResult,
} from "@octogent/core";

export {
  createVerdictWatcher,
  type VerdictWatcher,
  type VerdictWatcherConfig,
  type VerdictWatcherState,
  type WatcherObservation,
} from "./watcher";

export {
  checkProviderHealth,
  dispatchTask,
  type DispatchRequest,
} from "./dispatcher";

export {
  loadRoutingConfig,
  resolveRoutingPath,
  type RoutingLoadResult,
} from "./routing";

export type {
  DriverDispatchEvent,
  DriverDispatchResult,
  DriverHealthStatus,
  DriverInvocation,
} from "./dispatch-types";

export {
  DEFAULT_VOTE_CONFIG,
  tallyVotes,
  type VoteConfig,
  type VoteOutcome,
  type VoterVerdict,
} from "./vote";
