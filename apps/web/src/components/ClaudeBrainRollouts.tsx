import { useCallback, useEffect, useState } from "react";

type RolloutSummary = {
  rollout_id: string;
  agent_name: string;
  status: string;
  reward_total: number;
  started_at_iso: string | null;
  finished_at_iso: string | null;
  latency_ms: number | null;
};

type RolloutsResponse = {
  rollouts: RolloutSummary[];
  db_path: string;
  limit?: number;
  note?: string;
};

const formatRelative = (iso: string | null | undefined): string => {
  if (!iso) return "never";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const deltaMs = Date.now() - ms;
  const future = deltaMs < 0;
  const absMs = Math.abs(deltaMs);
  const seconds = Math.round(absMs / 1000);
  if (seconds < 60) return future ? `in ${seconds}s` : `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.round(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
};

const fetchRollouts = async (): Promise<RolloutsResponse> => {
  const response = await fetch("/api/claude-brain/rollouts?limit=50");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as RolloutsResponse;
};

const STATUS_COLORS: Record<string, string> = {
  succeeded: "true",
  running: "true",
  preparing: "true",
  queuing: "false",
  failed: "false",
  cancelled: "false",
  requeuing: "false",
};

const isTerminal = (status: string): boolean =>
  status === "succeeded" || status === "failed" || status === "cancelled";

const formatReward = (value: number): string => {
  if (!Number.isFinite(value)) return "0.00";
  return value.toFixed(2);
};

export const ClaudeBrainRollouts = () => {
  const [data, setData] = useState<RolloutsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchRollouts();
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

  return (
    <section className="claude-brain-view" aria-label="Claude-brain rollouts">
      <section className="claude-brain-panel" aria-label="AgentLightning rollouts">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Claude-brain agent rollouts</h2>
            <p>
              AgentLightning-lite trajectory + reward feed from the BriefingDeck store. Click
              refresh for an explicit recheck.
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

        {data && data.rollouts.length === 0 && !data.note && (
          <div className="claude-brain-note">No rollouts recorded yet.</div>
        )}

        <div className="claude-brain-grid">
          {data?.rollouts.map((rollout) => {
            const colorKey = STATUS_COLORS[rollout.status] ?? "false";
            const rewardClass =
              rollout.reward_total >= 0.7
                ? "true"
                : rollout.reward_total >= 0.4
                  ? "neutral"
                  : "false";
            return (
              <article
                key={rollout.rollout_id}
                className="claude-brain-card"
                data-active={colorKey}
              >
                <header className="claude-brain-card-header">
                  <span className="claude-brain-card-name">{rollout.agent_name}</span>
                  <span className="claude-brain-pill" data-active={colorKey}>
                    {rollout.status}
                  </span>
                </header>
                <dl className="claude-brain-card-body">
                  <div>
                    <dt>reward</dt>
                    <dd
                      data-active={rewardClass}
                      title={`raw=${rollout.reward_total}`}
                    >
                      {formatReward(rollout.reward_total)}
                    </dd>
                  </div>
                  <div>
                    <dt>latency</dt>
                    <dd>
                      {rollout.latency_ms !== null
                        ? `${rollout.latency_ms} ms`
                        : isTerminal(rollout.status)
                          ? "n/a"
                          : "in flight"}
                    </dd>
                  </div>
                  <div>
                    <dt>started</dt>
                    <dd title={rollout.started_at_iso ?? "never"}>
                      {formatRelative(rollout.started_at_iso)}
                    </dd>
                  </div>
                  <div>
                    <dt>id</dt>
                    <dd
                      title={rollout.rollout_id}
                      style={{
                        fontFamily: "monospace",
                        fontSize: "0.8em",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {rollout.rollout_id.slice(0, 12)}…
                    </dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>

        {data?.db_path && (
          <footer className="claude-brain-panel-footer">store · {data.db_path}</footer>
        )}
      </section>
    </section>
  );
};
