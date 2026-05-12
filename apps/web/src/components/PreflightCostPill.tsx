// Lane-3 cost-cap UX wave 2 — pre-flight pill.
//
// Renders next to the "Run cross-vendor vote" button. Shows estimated
// cost + voter count + (when daily-cap remaining is known) a guard
// against over-spend. The pill is the cost-visibility surface BEFORE the
// dispatch fires; the Gantt bar-color shift handles the AFTER state.

import { formatUsd } from "../lib/cost-cap-client";

type PreflightCostPillProps = {
  providers: ReadonlyArray<string>;
  estimate: number;
  remainingDailyUsd: number | null;
};

export const PreflightCostPill = ({
  providers,
  estimate,
  remainingDailyUsd,
}: PreflightCostPillProps) => {
  const wouldExceedDaily =
    remainingDailyUsd !== null && estimate > remainingDailyUsd;
  return (
    <span
      className="preflight-cost-pill"
      data-state={wouldExceedDaily ? "blocked" : "ready"}
      aria-label="Pre-flight cost estimate"
    >
      {wouldExceedDaily
        ? `Would exceed daily cap — ${formatUsd(remainingDailyUsd ?? 0)} left`
        : `~${formatUsd(estimate)} · ${providers.length} ${providers.length === 1 ? "voter" : "voters"}`}
    </span>
  );
};
