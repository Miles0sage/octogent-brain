import { useCallback, useEffect, useState } from "react";

type DaemonStatus = {
  name: string;
  kind: "timer" | "service";
  active: boolean;
  last_trigger_iso?: string | null;
  next_trigger_iso?: string | null;
  last_run_iso?: string | null;
  result?: string;
};

type DaemonsResponse = {
  daemons: DaemonStatus[];
  checked_at: string;
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

const fetchDaemons = async (): Promise<DaemonsResponse> => {
  const response = await fetch("/api/claude-brain/daemons");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as DaemonsResponse;
};

export const ClaudeBrainDaemons = () => {
  const [data, setData] = useState<DaemonsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchDaemons();
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
    <section className="claude-brain-view" aria-label="Claude-brain daemons">
      <section className="claude-brain-panel" aria-label="Self-improvement daemons">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Claude-brain self-improvement daemons</h2>
            <p>
              systemd units harvested from the host. Click refresh for an explicit recheck — no
              auto-poll.
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
            Failed to load daemons: {error}
          </div>
        )}

        {data?.note && <div className="claude-brain-note">{data.note}</div>}

        {data && data.daemons.length === 0 && !data.note && (
          <div className="claude-brain-note">No tracked daemons reported.</div>
        )}

        <div className="claude-brain-grid">
          {data?.daemons.map((daemon) => {
            const lastIso =
              daemon.kind === "timer" ? daemon.last_trigger_iso : daemon.last_run_iso;
            return (
              <article
                key={daemon.name}
                className="claude-brain-card"
                data-active={daemon.active ? "true" : "false"}
              >
                <header className="claude-brain-card-header">
                  <span className="claude-brain-card-name">{daemon.name}</span>
                  <span
                    className="claude-brain-pill"
                    data-active={daemon.active ? "true" : "false"}
                  >
                    {daemon.active ? "active" : "inactive"}
                  </span>
                </header>
                <dl className="claude-brain-card-body">
                  <div>
                    <dt>kind</dt>
                    <dd>{daemon.kind}</dd>
                  </div>
                  <div>
                    <dt>{daemon.kind === "timer" ? "last triggered" : "last run"}</dt>
                    <dd title={lastIso ?? "never"}>{formatRelative(lastIso)}</dd>
                  </div>
                  {daemon.kind === "timer" && (
                    <div>
                      <dt>next</dt>
                      <dd title={daemon.next_trigger_iso ?? "n/a"}>
                        {formatRelative(daemon.next_trigger_iso)}
                      </dd>
                    </div>
                  )}
                  {daemon.kind === "service" && daemon.result && (
                    <div>
                      <dt>result</dt>
                      <dd>{daemon.result}</dd>
                    </div>
                  )}
                </dl>
              </article>
            );
          })}
        </div>

        {data?.checked_at && (
          <footer className="claude-brain-panel-footer">
            checked {formatRelative(data.checked_at)} · {data.checked_at}
          </footer>
        )}
      </section>
    </section>
  );
};
