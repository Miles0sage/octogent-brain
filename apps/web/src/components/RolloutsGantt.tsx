import { useCallback, useEffect, useMemo, useState } from "react";

// Vote-outcome demo types. Mirrors the JSON shape returned by
// `POST /api/claude-brain/votes/dispatch` (see apps/api/src/createApiServer/voteRoutes.ts)
// and the underlying VoterVerdict / VoteOutcome primitives in
// packages/supervisor/src/vote.ts. Kept local + structural so we don't
// have to add a workspace dep on @octogent/supervisor for the web app.

interface ReviewerVerdictDTO {
  verdict: "pass" | "fail";
  improvements_exhausted: boolean;
  issues: ReadonlyArray<string>;
  scores: {
    groundedness: number;
    specificity: number;
  };
}

interface VoterVerdictDTO {
  provider: string;
  verdict: ReviewerVerdictDTO | null;
  raw_output: string;
  error?: string;
}

interface VoteOutcomeDTO {
  winner: "pass" | "fail" | "no-consensus";
  reason: string;
  consensus_count: number;
  dissent_count: number;
  verdicts: ReadonlyArray<VoterVerdictDTO>;
}

interface VoteDispatchResponse {
  vote_id: string;
  outcome: VoteOutcomeDTO;
  dispatch_ids: ReadonlyArray<string>;
  started_at_iso: string;
  duration_ms: number;
}

const VOTE_DEMO_DEFAULT_TASK =
  "Reviewer task: verify the most recent change passes groundedness+specificity gates.";

const dispatchVote = async (params: {
  taskInput: string;
  dryRun: boolean;
}): Promise<VoteDispatchResponse> => {
  const response = await fetch("/api/claude-brain/votes/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      taskInput: params.taskInput,
      taskType: "verify",
      dryRun: params.dryRun,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as VoteDispatchResponse;
};

const clampUnit = (n: number): number => {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
};

type RolloutRow = {
  rollout_id: string;
  agent_name: string;
  status: string;
  reward_total: number;
  started_at_iso: string | null;
  finished_at_iso: string | null;
  latency_ms: number | null;
};

type RolloutsResponse = {
  rollouts: RolloutRow[];
  db_path: string;
  limit?: number;
  note?: string;
};

type GanttBar = {
  rollout: RolloutRow;
  startMs: number;
  endMs: number;
  lane: number;
  laneLabel: string;
};

type GanttData = {
  bars: GanttBar[];
  windowStartMs: number;
  windowEndMs: number;
  lanes: string[];
  inFlightCount: number;
};

const STATUS_FILL: Record<string, string> = {
  succeeded: "#1f7a3a",
  running: "#1e6fbe",
  preparing: "#1e6fbe",
  failed: "#a83232",
  cancelled: "#5a5a5a",
  queuing: "#7a6a1f",
};

const STATUS_STROKE: Record<string, string> = {
  succeeded: "#2fb55a",
  running: "#3a9bff",
  preparing: "#3a9bff",
  failed: "#dc4a4a",
  cancelled: "#999999",
  queuing: "#d4b840",
};

const BAR_HEIGHT = 22;
const LANE_GAP = 6;
const LANE_LABEL_WIDTH = 200;
const AXIS_HEIGHT = 28;
const CHART_HORIZONTAL_PADDING = 16;
const MIN_BAR_WIDTH = 4;

const fetchRollouts = async (limit: number): Promise<RolloutsResponse> => {
  const response = await fetch(`/api/claude-brain/rollouts?limit=${limit}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as RolloutsResponse;
};

const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
};

const formatClock = (epochMs: number): string => {
  const d = new Date(epochMs);
  return d.toISOString().slice(11, 19);
};

const computeGanttData = (rollouts: RolloutRow[]): GanttData => {
  const nowMs = Date.now();
  const usable = rollouts.filter((row) => row.started_at_iso !== null);

  const laneOrder: string[] = [];
  const laneIndex = new Map<string, number>();
  for (const row of usable) {
    if (!laneIndex.has(row.agent_name)) {
      laneIndex.set(row.agent_name, laneOrder.length);
      laneOrder.push(row.agent_name);
    }
  }

  let minStart = Number.POSITIVE_INFINITY;
  let maxEnd = Number.NEGATIVE_INFINITY;
  let inFlightCount = 0;

  const bars: GanttBar[] = usable.map((row) => {
    const startMs = row.started_at_iso ? Date.parse(row.started_at_iso) : nowMs;
    const isInFlight = row.finished_at_iso === null;
    const endMs = isInFlight
      ? nowMs
      : row.finished_at_iso
        ? Date.parse(row.finished_at_iso)
        : nowMs;
    if (isInFlight) inFlightCount += 1;
    if (startMs < minStart) minStart = startMs;
    if (endMs > maxEnd) maxEnd = endMs;
    return {
      rollout: row,
      startMs,
      endMs,
      lane: laneIndex.get(row.agent_name) ?? 0,
      laneLabel: row.agent_name,
    };
  });

  if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) {
    minStart = nowMs - 60_000;
    maxEnd = nowMs;
  }
  if (maxEnd - minStart < 1000) {
    maxEnd = minStart + 1000;
  }

  return {
    bars,
    windowStartMs: minStart,
    windowEndMs: maxEnd,
    lanes: laneOrder,
    inFlightCount,
  };
};

const buildTicks = (
  windowStartMs: number,
  windowEndMs: number,
  chartWidth: number,
): Array<{ x: number; label: string }> => {
  const range = windowEndMs - windowStartMs;
  if (range <= 0) return [];
  const targetTickCount = Math.max(4, Math.min(8, Math.round(chartWidth / 90)));
  const niceSteps = [
    1000, 2000, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000, 1_800_000, 3_600_000,
    7_200_000, 21_600_000, 43_200_000, 86_400_000,
  ];
  let step = niceSteps[niceSteps.length - 1] ?? 1000;
  for (const candidate of niceSteps) {
    if (range / candidate <= targetTickCount) {
      step = candidate;
      break;
    }
  }
  const ticks: Array<{ x: number; label: string }> = [];
  const firstTick = Math.ceil(windowStartMs / step) * step;
  for (let t = firstTick; t <= windowEndMs; t += step) {
    const x = ((t - windowStartMs) / range) * chartWidth;
    ticks.push({ x, label: formatClock(t) });
  }
  return ticks;
};

export const RolloutsGantt = () => {
  const [data, setData] = useState<RolloutsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [chartWidth, setChartWidth] = useState(900);
  const [selectedRollout, setSelectedRollout] = useState<RolloutRow | null>(null);

  // Vote-outcome demo state. The vote panel sits below the Gantt and
  // doesn't share fetch state with the rollouts loader — keeps fetch
  // failures on either side from cross-contaminating the other panel.
  const [voteTaskInput, setVoteTaskInput] = useState<string>(VOTE_DEMO_DEFAULT_TASK);
  const [voteDryRun, setVoteDryRun] = useState<boolean>(true);
  const [voteResult, setVoteResult] = useState<VoteDispatchResponse | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);
  const [isVoteRunning, setIsVoteRunning] = useState<boolean>(false);

  const runVote = useCallback(async () => {
    setIsVoteRunning(true);
    setVoteError(null);
    try {
      const next = await dispatchVote({
        taskInput: voteTaskInput,
        dryRun: voteDryRun,
      });
      setVoteResult(next);
    } catch (err) {
      setVoteError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsVoteRunning(false);
    }
  }, [voteTaskInput, voteDryRun]);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchRollouts(200);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const handleResize = () => {
      const padding = LANE_LABEL_WIDTH + CHART_HORIZONTAL_PADDING * 2 + 40;
      const width = Math.max(400, Math.min(1600, window.innerWidth - padding));
      setChartWidth(width);
    };
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  const ganttData = useMemo(
    () => (data ? computeGanttData(data.rollouts) : null),
    [data],
  );

  const ticks = useMemo(
    () =>
      ganttData
        ? buildTicks(ganttData.windowStartMs, ganttData.windowEndMs, chartWidth)
        : [],
    [ganttData, chartWidth],
  );

  const chartHeight = ganttData
    ? Math.max(40, ganttData.lanes.length * (BAR_HEIGHT + LANE_GAP) + AXIS_HEIGHT)
    : 40;

  const windowSpanMs = ganttData ? ganttData.windowEndMs - ganttData.windowStartMs : 0;

  return (
    <section className="claude-brain-view" aria-label="Rollouts Gantt waterfall">
      <section className="claude-brain-panel" aria-label="Rollouts Gantt">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Agent rollouts — Gantt waterfall</h2>
            <p>
              Time-axis view of AgentLightning-lite rollouts. Each row is an{" "}
              <code>agent_name</code>; each bar is a rollout (color = status).
              Refresh explicit — no auto-poll.
            </p>
          </div>
          <button
            className="claude-brain-refresh"
            type="button"
            onClick={() => {
              void refresh();
            }}
            disabled={isLoading}
          >
            {isLoading ? "Refreshing…" : "Refresh"}
          </button>
        </header>

        {error && (
          <div className="claude-brain-error" role="alert">
            Failed to load rollouts: {error}
          </div>
        )}

        {data?.note && <div className="claude-brain-note">{data.note}</div>}

        {ganttData && (
          <div className="claude-brain-summary-row" aria-label="Gantt summary stats">
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Rollouts</span>
              <span className="claude-brain-stat-value">{ganttData.bars.length}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Lanes</span>
              <span className="claude-brain-stat-value">{ganttData.lanes.length}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">In flight</span>
              <span className="claude-brain-stat-value">{ganttData.inFlightCount}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Window</span>
              <span className="claude-brain-stat-value">{formatDuration(windowSpanMs)}</span>
            </div>
          </div>
        )}

        {ganttData && ganttData.bars.length === 0 && (
          <div className="claude-brain-note">No rollouts to render.</div>
        )}

        {ganttData && ganttData.bars.length > 0 && (
          <div className="claude-brain-gantt-wrap" role="img" aria-label="Gantt chart">
            <svg
              width={LANE_LABEL_WIDTH + chartWidth + CHART_HORIZONTAL_PADDING * 2}
              height={chartHeight + 20}
              style={{ display: "block", maxWidth: "100%" }}
            >
              <title>Agent rollouts waterfall</title>

              {ganttData.lanes.map((lane, idx) => {
                const y = idx * (BAR_HEIGHT + LANE_GAP) + AXIS_HEIGHT + BAR_HEIGHT / 2 + 4;
                return (
                  <text
                    key={`lane-${lane}`}
                    x={LANE_LABEL_WIDTH - 8}
                    y={y}
                    textAnchor="end"
                    fontSize={11}
                    fill="#cbd0d6"
                    fontFamily="ui-monospace, monospace"
                  >
                    {lane.length > 28 ? `${lane.slice(0, 26)}…` : lane}
                  </text>
                );
              })}

              <line
                x1={LANE_LABEL_WIDTH}
                y1={AXIS_HEIGHT - 2}
                x2={LANE_LABEL_WIDTH + chartWidth}
                y2={AXIS_HEIGHT - 2}
                stroke="#3a4048"
                strokeWidth={1}
              />
              {ticks.map((tick) => (
                <g
                  key={`tick-${tick.label}-${tick.x}`}
                  transform={`translate(${LANE_LABEL_WIDTH + tick.x},0)`}
                >
                  <line
                    x1={0}
                    y1={AXIS_HEIGHT - 6}
                    x2={0}
                    y2={chartHeight}
                    stroke="#2a3036"
                    strokeWidth={1}
                  />
                  <text
                    x={0}
                    y={AXIS_HEIGHT - 10}
                    textAnchor="middle"
                    fontSize={10}
                    fill="#8a9099"
                    fontFamily="ui-monospace, monospace"
                  >
                    {tick.label}
                  </text>
                </g>
              ))}

              {ganttData.bars.map((bar) => {
                const xRatio =
                  (bar.startMs - ganttData.windowStartMs) /
                  (ganttData.windowEndMs - ganttData.windowStartMs);
                const widthRatio =
                  (bar.endMs - bar.startMs) /
                  (ganttData.windowEndMs - ganttData.windowStartMs);
                const x = LANE_LABEL_WIDTH + xRatio * chartWidth;
                const width = Math.max(MIN_BAR_WIDTH, widthRatio * chartWidth);
                const y = bar.lane * (BAR_HEIGHT + LANE_GAP) + AXIS_HEIGHT + 4;
                const fill = STATUS_FILL[bar.rollout.status] ?? "#5a5a5a";
                const stroke = STATUS_STROKE[bar.rollout.status] ?? "#888";
                const isInFlight = bar.rollout.finished_at_iso === null;
                const isSelected = selectedRollout?.rollout_id === bar.rollout.rollout_id;
                const labelText =
                  width > 60 ? bar.rollout.rollout_id.replace(/^rl-/, "") : "";
                return (
                  <g
                    key={bar.rollout.rollout_id}
                    style={{ cursor: "pointer" }}
                    onClick={() => {
                      setSelectedRollout(bar.rollout);
                    }}
                  >
                    <title>
                      {`${bar.rollout.agent_name} · ${bar.rollout.rollout_id}\n` +
                        `status: ${bar.rollout.status}${isInFlight ? " (in flight)" : ""}\n` +
                        `started: ${bar.rollout.started_at_iso}\n` +
                        `finished: ${bar.rollout.finished_at_iso ?? "—"}\n` +
                        `latency: ${bar.rollout.latency_ms !== null ? formatDuration(bar.rollout.latency_ms) : "—"}\n` +
                        `reward: ${bar.rollout.reward_total.toFixed(3)}`}
                    </title>
                    <rect
                      x={x}
                      y={y}
                      width={width}
                      height={BAR_HEIGHT}
                      rx={3}
                      fill={fill}
                      stroke={isSelected ? "#f0f0f0" : stroke}
                      strokeWidth={isSelected ? 2 : 1}
                      opacity={isInFlight ? 0.75 : 1}
                    />
                    {labelText && (
                      <text
                        x={x + 6}
                        y={y + BAR_HEIGHT / 2 + 4}
                        fontSize={10}
                        fill="#f4f6f8"
                        fontFamily="ui-monospace, monospace"
                        pointerEvents="none"
                      >
                        {labelText}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          </div>
        )}

        {selectedRollout && (
          <aside className="claude-brain-detail" aria-label="Selected rollout detail">
            <header className="claude-brain-detail-header">
              <h3>{selectedRollout.rollout_id}</h3>
              <button
                type="button"
                className="claude-brain-refresh"
                onClick={() => {
                  setSelectedRollout(null);
                }}
              >
                Close
              </button>
            </header>
            <dl className="claude-brain-detail-list">
              <dt>agent</dt>
              <dd>
                <code>{selectedRollout.agent_name}</code>
              </dd>
              <dt>status</dt>
              <dd>{selectedRollout.status}</dd>
              <dt>started</dt>
              <dd>{selectedRollout.started_at_iso ?? "—"}</dd>
              <dt>finished</dt>
              <dd>{selectedRollout.finished_at_iso ?? "in flight"}</dd>
              <dt>latency</dt>
              <dd>
                {selectedRollout.latency_ms !== null
                  ? formatDuration(selectedRollout.latency_ms)
                  : "—"}
              </dd>
              <dt>reward</dt>
              <dd>{selectedRollout.reward_total.toFixed(3)}</dd>
            </dl>
          </aside>
        )}

        <VoteDemoSection
          taskInput={voteTaskInput}
          onTaskInputChange={setVoteTaskInput}
          dryRun={voteDryRun}
          onDryRunChange={setVoteDryRun}
          isRunning={isVoteRunning}
          onRun={runVote}
          result={voteResult}
          error={voteError}
        />
      </section>
    </section>
  );
};

interface VoteDemoSectionProps {
  taskInput: string;
  onTaskInputChange: (next: string) => void;
  dryRun: boolean;
  onDryRunChange: (next: boolean) => void;
  isRunning: boolean;
  onRun: () => void;
  result: VoteDispatchResponse | null;
  error: string | null;
}

const VoteDemoSection = ({
  taskInput,
  onTaskInputChange,
  dryRun,
  onDryRunChange,
  isRunning,
  onRun,
  result,
  error,
}: VoteDemoSectionProps) => {
  return (
    <section
      className="claude-brain-vote-demo"
      aria-label="Cross-vendor vote demo"
    >
      <header className="claude-brain-panel-header">
        <div>
          <h3>Cross-vendor vote — mechanical supervision</h3>
          <p>
            Ship the same task to every evaluator-capable driver in parallel,
            tally the verdicts mechanically. Anthropic structurally cannot
            ship this (cannibalizes Claude API revenue); we can.
          </p>
        </div>
        <button
          className="claude-brain-refresh"
          type="button"
          onClick={() => {
            onRun();
          }}
          disabled={isRunning || taskInput.trim().length === 0}
        >
          {isRunning ? "Voting…" : "Run cross-vendor vote"}
        </button>
      </header>

      <div className="claude-brain-vote-controls">
        <label className="claude-brain-vote-task-label">
          <span>Task input</span>
          <textarea
            aria-label="Task input"
            value={taskInput}
            onChange={(e) => {
              onTaskInputChange(e.currentTarget.value);
            }}
            rows={2}
            className="claude-brain-vote-task-input"
          />
        </label>
        <label className="claude-brain-vote-dryrun-label">
          <input
            type="checkbox"
            checked={dryRun}
            onChange={(e) => {
              onDryRunChange(e.currentTarget.checked);
            }}
            aria-label="Dry-run mode"
          />
          <span>Dry run (skip subprocess spawn)</span>
        </label>
      </div>

      {error && (
        <div
          className="claude-brain-error"
          role="alert"
          aria-label="Vote error"
        >
          Vote dispatch failed: {error}
        </div>
      )}

      {!error && !result && (
        <div className="claude-brain-note">
          No vote run yet. Click "Run cross-vendor vote" to fan out to every
          evaluator-capable driver and watch consensus form.
        </div>
      )}

      {result && (
        <VoteOutcomeCard outcome={result.outcome} durationMs={result.duration_ms} />
      )}
    </section>
  );
};

interface VoteOutcomeCardProps {
  outcome: VoteOutcomeDTO;
  durationMs: number;
}

const VoteOutcomeCard = ({ outcome, durationMs }: VoteOutcomeCardProps) => {
  const winnerLabel = outcome.winner;
  // data-active conventions: "true" => green pass styling, "false" => red
  // fail styling, omit attr => neutral grey (no-consensus). Matches the
  // existing claude-brain-pill CSS contract in console-canvas-claude-brain.css.
  const pillProps: { "data-active"?: "true" | "false" } =
    winnerLabel === "pass"
      ? { "data-active": "true" }
      : winnerLabel === "fail"
        ? { "data-active": "false" }
        : {};

  const totalVoters = outcome.verdicts.length;
  const consensusReached = totalVoters - outcome.dissent_count;

  return (
    <div
      className="claude-brain-vote-outcome"
      aria-label="Vote outcome"
    >
      <div className="claude-brain-vote-summary">
        <span
          className="claude-brain-pill"
          aria-label="Vote winner"
          {...pillProps}
        >
          {winnerLabel}
        </span>
        <div className="claude-brain-summary-row" aria-label="Vote summary stats">
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Voters</span>
            <span className="claude-brain-stat-value">{totalVoters}</span>
          </div>
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Consensus</span>
            <span className="claude-brain-stat-value">{outcome.consensus_count}</span>
          </div>
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Dissent</span>
            <span className="claude-brain-stat-value">{outcome.dissent_count}</span>
          </div>
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Duration</span>
            <span className="claude-brain-stat-value">{formatDuration(durationMs)}</span>
          </div>
        </div>
      </div>

      <div className="claude-brain-note">{outcome.reason}</div>

      <ConsensusArrow
        total={totalVoters}
        consensus={consensusReached}
        winner={winnerLabel}
      />

      <ol
        className="claude-brain-vote-voters"
        aria-label="Per-voter breakdown"
      >
        {outcome.verdicts.map((voter) => (
          <VoterRow key={voter.provider} voter={voter} />
        ))}
      </ol>
    </div>
  );
};

interface VoterRowProps {
  voter: VoterVerdictDTO;
}

const VoterRow = ({ voter }: VoterRowProps) => {
  const verdictText = voter.verdict === null ? "—" : voter.verdict.verdict;
  const groundedness = voter.verdict?.scores.groundedness ?? 0;
  const specificity = voter.verdict?.scores.specificity ?? 0;
  const pillProps: { "data-active"?: "true" | "false" } =
    verdictText === "pass"
      ? { "data-active": "true" }
      : verdictText === "fail"
        ? { "data-active": "false" }
        : {};

  return (
    <li className="claude-brain-vote-voter-row">
      <code className="claude-brain-vote-voter-name">{voter.provider}</code>
      <span
        className="claude-brain-pill"
        aria-label={`${voter.provider} verdict`}
        {...pillProps}
      >
        {verdictText}
      </span>
      <ScoreBar label="grnd" value={groundedness} />
      <ScoreBar label="spec" value={specificity} />
      {voter.error && (
        <span className="claude-brain-vote-voter-error">{voter.error}</span>
      )}
    </li>
  );
};

interface ScoreBarProps {
  label: string;
  value: number;
}

const ScoreBar = ({ label, value }: ScoreBarProps) => {
  const pct = Math.round(clampUnit(value) * 100);
  return (
    <span className="claude-brain-vote-score" aria-label={`${label} score`}>
      <span className="claude-brain-vote-score-label">{label}</span>
      <span
        className="claude-brain-vote-score-bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <span
          className="claude-brain-vote-score-fill"
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className="claude-brain-vote-score-value">{value.toFixed(2)}</span>
    </span>
  );
};

interface ConsensusArrowProps {
  total: number;
  consensus: number;
  winner: VoteOutcomeDTO["winner"];
}

const ConsensusArrow = ({ total, consensus, winner }: ConsensusArrowProps) => {
  // Compact SVG: N circles flowing toward a gate; dissenters split off
  // above the gate, consensus voters flow through. Demo-grade graphic, not
  // a load-bearing visualization.
  if (total === 0) return null;
  const dissent = total - consensus;
  const gateColor =
    winner === "pass" ? "#2fb55a" : winner === "fail" ? "#dc4a4a" : "#888";
  const width = 280;
  const height = 80;
  const radius = 8;
  return (
    <svg
      className="claude-brain-vote-arrow"
      width={width}
      height={height}
      role="img"
      aria-label="Consensus flow diagram"
    >
      <title>Consensus arrow: {consensus} reach gate, {dissent} dissent</title>
      {/* gate on the right */}
      <rect
        x={width - 30}
        y={height / 2 - 18}
        width={20}
        height={36}
        rx={3}
        fill="transparent"
        stroke={gateColor}
        strokeWidth={2}
      />
      <text
        x={width - 20}
        y={height / 2 + 4}
        textAnchor="middle"
        fontSize={10}
        fill={gateColor}
        fontFamily="ui-monospace, monospace"
      >
        gate
      </text>
      {Array.from({ length: total }, (_, idx) => {
        const isDissenter = idx >= consensus;
        const startX = 12;
        const startY = height / 2 + (idx - (total - 1) / 2) * 8;
        const endX = isDissenter ? width - 60 : width - 40;
        const endY = isDissenter ? 12 : height / 2;
        return (
          <g key={`voter-${idx}`}>
            <line
              x1={startX}
              y1={startY}
              x2={endX}
              y2={endY}
              stroke={isDissenter ? "#a83232" : gateColor}
              strokeWidth={1.5}
              opacity={0.7}
            />
            <circle
              cx={startX}
              cy={startY}
              r={radius / 2}
              fill={isDissenter ? "#a83232" : gateColor}
            />
          </g>
        );
      })}
    </svg>
  );
};
