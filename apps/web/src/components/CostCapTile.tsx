// Lane-3 cost-cap UX wave 2 — stat-tile component.
//
// Sits to the left of RuntimeStatusStrip's Claude Session % rail. Renders
// "🐙 $X.XX / $YY.YY" + a thin 10-segment bar. Color shifts at 50% and
// 90%. The bar-color shift is the persistent visual cue (no toast, no
// modal — screenshots/gifs read correctly).
//
// API contract: GET /api/claude-brain/cost-cap returns { config, usage }
// or 404 when no cap is configured. 404 collapses to an empty wrapper
// per the spec's tier-gate behavior — the UI never displays errors for
// the free no-cap state.

import { useEffect, useState } from "react";

import {
  fetchCostCapStatus,
  formatResetIn,
  formatUsd,
  type CostCapStatus,
} from "../lib/cost-cap-client";

const POLL_INTERVAL_MS = 5000;

type CapState = "slate" | "amber" | "red";

const computeCapState = (spent: number, cap: number): CapState => {
  if (cap <= 0) return "slate";
  const ratio = spent / cap;
  if (ratio >= 0.9) return "red";
  if (ratio >= 0.5) return "amber";
  return "slate";
};

const BAR_SEGMENTS = 10;

export const CostCapTile = () => {
  const [status, setStatus] = useState<CostCapStatus | null>(null);
  const [unconfigured, setUnconfigured] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchCostCapStatus();
        if (cancelled) return;
        if (next === null) {
          setUnconfigured(true);
          setStatus(null);
        } else {
          setUnconfigured(false);
          setStatus(next);
        }
      } catch {
        // Transient errors do not flash a banner — the tile just keeps
        // its last-known state. The Spend subtab surfaces operational
        // failures.
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (unconfigured || status === null) {
    return <div className="cost-cap-tile cost-cap-tile--unconfigured" />;
  }

  const { config, usage } = status;
  const capState = computeCapState(usage.daySpentUsd, config.perDayUsd);
  const filledSegments = Math.min(
    BAR_SEGMENTS,
    Math.max(0, Math.round((usage.daySpentUsd / Math.max(0.0001, config.perDayUsd)) * BAR_SEGMENTS)),
  );
  const resetLabel = formatResetIn(Date.now(), usage.dayStart);

  return (
    <div
      className="cost-cap-tile"
      aria-label="Daily spend vs cap"
      data-cap-state={capState}
      data-pulsing={capState === "red" ? "true" : "false"}
      title={resetLabel}
    >
      <span className="cost-cap-tile-icon" aria-hidden="true">
        🐙
      </span>
      <span className="cost-cap-tile-amount">
        {formatUsd(usage.daySpentUsd)} / {formatUsd(config.perDayUsd)}
      </span>
      <span className="cost-cap-tile-bar" aria-hidden="true">
        {Array.from({ length: BAR_SEGMENTS }).map((_, i) => (
          <span
            key={i}
            className="cost-cap-tile-bar-segment"
            data-filled={i < filledSegments ? "true" : "false"}
          />
        ))}
      </span>
    </div>
  );
};
