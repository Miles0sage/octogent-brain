import { useCallback, useEffect, useState } from "react";

type AgentTeamInbox = {
  teammate: string;
  message_count: number;
  unread_count: number;
  last_timestamp_iso: string | null;
  path: string;
};

type AgentTeamSummary = {
  name: string;
  inboxes: AgentTeamInbox[];
  total_messages: number;
  total_unread: number;
  last_activity_iso: string | null;
};

type AgentTaskSnapshot = {
  session_id: string;
  size_bytes: number;
  modified_iso: string;
  has_lock: boolean;
  highwatermark: string | null;
};

type AgentTeamsPayload = {
  teams: AgentTeamSummary[];
  tasks: AgentTaskSnapshot[];
  source_paths: { teams_dir: string; tasks_dir: string };
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

const shortSession = (sessionId: string): string => {
  if (sessionId.length <= 12) return sessionId;
  return `${sessionId.slice(0, 8)}…${sessionId.slice(-4)}`;
};

const fetchAgentTeams = async (): Promise<AgentTeamsPayload> => {
  const response = await fetch("/api/claude-brain/agent-teams");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as AgentTeamsPayload;
};

export const ClaudeBrainAgentTeams = () => {
  const [data, setData] = useState<AgentTeamsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const next = await fetchAgentTeams();
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

  const teamCount = data?.teams.length ?? 0;
  const taskCount = data?.tasks.length ?? 0;
  const lockedTasks = data?.tasks.filter((task) => task.has_lock).length ?? 0;

  return (
    <section className="claude-brain-view" aria-label="Anthropic agent-teams + agent-tasks">
      <section className="claude-brain-panel" aria-label="Agent teams snapshot">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Anthropic agent-teams + tasks</h2>
            <p>
              Read-only mirror of <code>~/.claude/teams/&lt;name&gt;/inboxes/</code> (mailbox) and{" "}
              <code>~/.claude/tasks/&lt;session-id&gt;/</code> (task-claim state). Refresh is explicit
              — no auto-poll.
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
            Failed to load agent-teams: {error}
          </div>
        )}

        {data?.note && <div className="claude-brain-note">{data.note}</div>}

        {data && (
          <div className="claude-brain-summary-row" aria-label="Agent-teams summary stats">
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Teams</span>
              <span className="claude-brain-stat-value">{teamCount}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Active tasks</span>
              <span className="claude-brain-stat-value">{taskCount}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Locked tasks</span>
              <span className="claude-brain-stat-value">{lockedTasks}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Last refresh</span>
              <span className="claude-brain-stat-value">{formatRelative(data.checked_at)}</span>
            </div>
          </div>
        )}

        {data && teamCount === 0 && !data.note && (
          <div className="claude-brain-note">No teams found.</div>
        )}

        {data?.teams.map((team) => (
          <article
            key={team.name}
            className="claude-brain-team-card"
            aria-label={`Team ${team.name}`}
          >
            <header className="claude-brain-team-header">
              <h3>{team.name}</h3>
              <span className="claude-brain-team-meta">
                {team.total_messages} msg · {team.total_unread} unread · last{" "}
                {formatRelative(team.last_activity_iso)}
              </span>
            </header>
            {team.inboxes.length === 0 ? (
              <div className="claude-brain-note">No inboxes for this team.</div>
            ) : (
              <ul className="claude-brain-inbox-list">
                {team.inboxes.map((inbox) => (
                  <li key={inbox.path} className="claude-brain-inbox-row">
                    <span className="claude-brain-inbox-teammate">{inbox.teammate}</span>
                    <span className="claude-brain-inbox-counts">
                      {inbox.message_count} msg
                      {inbox.unread_count > 0 ? ` · ${inbox.unread_count} unread` : ""}
                    </span>
                    <span className="claude-brain-inbox-last">
                      {formatRelative(inbox.last_timestamp_iso)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </article>
        ))}
      </section>

      <section className="claude-brain-panel" aria-label="Agent task-claim state">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Task-claim state</h2>
            <p>
              Sessions tracking the Task tool's <code>.highwatermark</code> +{" "}
              <code>.lock</code> files. Lock present = a teammate is currently claiming a task.
            </p>
          </div>
        </header>

        {data && data.tasks.length === 0 && (
          <div className="claude-brain-note">No active task sessions.</div>
        )}

        {data && data.tasks.length > 0 && (
          <table className="claude-brain-table">
            <thead>
              <tr>
                <th scope="col">Session</th>
                <th scope="col">High-watermark</th>
                <th scope="col">Lock</th>
                <th scope="col">Modified</th>
              </tr>
            </thead>
            <tbody>
              {data.tasks.map((task) => (
                <tr key={task.session_id}>
                  <td title={task.session_id}>
                    <code>{shortSession(task.session_id)}</code>
                  </td>
                  <td>{task.highwatermark ?? "—"}</td>
                  <td>{task.has_lock ? "🔒 held" : "—"}</td>
                  <td>{formatRelative(task.modified_iso)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {data && (
          <footer className="claude-brain-panel-footer">
            <small>
              Source: <code>{data.source_paths.teams_dir}</code> +{" "}
              <code>{data.source_paths.tasks_dir}</code>
            </small>
          </footer>
        )}
      </section>
    </section>
  );
};
