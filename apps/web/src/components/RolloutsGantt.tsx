import { useCallback, useEffect, useMemo, useState } from "react";

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
      </section>
    </section>
  );
};
