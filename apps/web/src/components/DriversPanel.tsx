import { useCallback, useEffect, useMemo, useState } from "react";

type DriverTransport = "stdio" | "acp" | "pty";
type DriverCapability = "writer" | "evaluator" | "intel" | "all";

interface DriverHealthHealthy {
  healthy: true;
}
interface DriverHealthBinaryMissing {
  healthy: false;
  reason: "binary-missing";
  binary: string;
}
interface DriverHealthEnvMissing {
  healthy: false;
  reason: "env-missing";
  missing: string[];
}
interface DriverHealthTransportUnsupported {
  healthy: false;
  reason: "transport-unsupported";
  transport: string;
}
interface DriverHealthNoDriver {
  healthy: false;
  reason: "no-driver-for-task";
  taskType: string;
}

type DriverHealth =
  | DriverHealthHealthy
  | DriverHealthBinaryMissing
  | DriverHealthEnvMissing
  | DriverHealthTransportUnsupported
  | DriverHealthNoDriver;

interface DriverRow {
  provider: string;
  transport: DriverTransport;
  capabilities: DriverCapability[];
  command: string;
  requiredEnv: string[];
  maxCostUsd: number;
  health: DriverHealth;
}

interface RoutingRule {
  taskType: string;
  preferred: string;
  fallback: string[];
  extraArgs: string[];
}

interface DriversListResponse {
  config_source: "default" | "user-file";
  defaultProvider: string;
  drivers: DriverRow[];
  rules: RoutingRule[];
}

interface DispatchEvent {
  kind: "stdout" | "stderr" | "exit" | "error";
  data?: string;
  message?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
}

interface DispatchResult {
  dispatch_id: string;
  taskType: string;
  invocation: {
    provider: string;
    command: string;
    args: string[];
    cwd: string;
    envFlags: string[];
  } | null;
  health: DriverHealth;
  started_at_iso: string;
  events: DispatchEvent[];
  exit_code: number | null;
  duration_ms: number | null;
}

const formatHealth = (health: DriverHealth): { label: string; tone: "ok" | "warn" | "err" } => {
  if (health.healthy) return { label: "✓ healthy", tone: "ok" };
  switch (health.reason) {
    case "binary-missing":
      return { label: `✗ binary missing: ${health.binary}`, tone: "err" };
    case "env-missing":
      return { label: `⚠ env missing: ${health.missing.join(", ")}`, tone: "warn" };
    case "transport-unsupported":
      return { label: `⏳ ${health.transport} transport not wired`, tone: "warn" };
    case "no-driver-for-task":
      return { label: `✗ no driver for ${health.taskType}`, tone: "err" };
  }
};

const PILL_DATA_ACTIVE: Record<"ok" | "warn" | "err", string> = {
  ok: "true",
  warn: "false",
  err: "false",
};

const fetchDrivers = async (): Promise<DriversListResponse> => {
  const response = await fetch("/api/claude-brain/drivers");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as DriversListResponse;
};

const runDispatch = async (body: {
  taskType: string;
  taskInput: string;
  cwd: string;
  dryRun: boolean;
}): Promise<DispatchResult> => {
  const response = await fetch("/api/claude-brain/drivers/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as DispatchResult;
};

export const DriversPanel = () => {
  const [data, setData] = useState<DriversListResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [taskType, setTaskType] = useState("refactor");
  const [taskInput, setTaskInput] = useState("rename function foo to bar");
  const [cwd, setCwd] = useState("/root/briefingdeck");
  const [dryRun, setDryRun] = useState(true);
  const [dispatchResult, setDispatchResult] = useState<DispatchResult | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const next = await fetchDrivers();
      setData(next);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleDispatch = useCallback(async () => {
    setIsDispatching(true);
    setDispatchError(null);
    try {
      const next = await runDispatch({ taskType, taskInput, cwd, dryRun });
      setDispatchResult(next);
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsDispatching(false);
    }
  }, [taskType, taskInput, cwd, dryRun]);

  const healthyCount = useMemo(
    () => data?.drivers.filter((d) => d.health.healthy).length ?? 0,
    [data],
  );

  const stdoutChunks = useMemo(() => {
    if (!dispatchResult) return "";
    return dispatchResult.events
      .filter((e) => e.kind === "stdout")
      .map((e) => e.data ?? "")
      .join("");
  }, [dispatchResult]);

  const stderrChunks = useMemo(() => {
    if (!dispatchResult) return "";
    return dispatchResult.events
      .filter((e) => e.kind === "stderr")
      .map((e) => e.data ?? "")
      .join("");
  }, [dispatchResult]);

  return (
    <section className="claude-brain-view" aria-label="Cross-CLI drivers + dispatch playground">
      <section className="claude-brain-panel" aria-label="Configured drivers">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Cross-CLI drivers</h2>
            <p>
              Health probes for each driver in <code>routing.json</code> (or the
              shipped default). Aider writes; Claude Code evaluates; Codex stays
              as alternate writer; Gemini CLI gives intel. Per NotebookLM
              synthesis 2026-05-11.
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

        {loadError && (
          <div className="claude-brain-error" role="alert">
            Failed to load drivers: {loadError}
          </div>
        )}

        {data && (
          <div className="claude-brain-summary-row" aria-label="Driver stats">
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Drivers</span>
              <span className="claude-brain-stat-value">{data.drivers.length}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Healthy</span>
              <span className="claude-brain-stat-value">{healthyCount}</span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Default</span>
              <span className="claude-brain-stat-value" style={{ fontSize: "0.82rem" }}>
                {data.defaultProvider}
              </span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Config</span>
              <span className="claude-brain-stat-value" style={{ fontSize: "0.82rem" }}>
                {data.config_source}
              </span>
            </div>
          </div>
        )}

        {data && (
          <table className="claude-brain-table">
            <thead>
              <tr>
                <th scope="col">Provider</th>
                <th scope="col">Transport</th>
                <th scope="col">Capabilities</th>
                <th scope="col">Command</th>
                <th scope="col">Required env</th>
                <th scope="col">Health</th>
              </tr>
            </thead>
            <tbody>
              {data.drivers.map((driver) => {
                const formatted = formatHealth(driver.health);
                return (
                  <tr key={driver.provider}>
                    <td>
                      <code>{driver.provider}</code>
                    </td>
                    <td>{driver.transport}</td>
                    <td>{driver.capabilities.join(", ")}</td>
                    <td>
                      <code>{driver.command}</code>
                    </td>
                    <td>
                      {driver.requiredEnv.length === 0
                        ? "—"
                        : driver.requiredEnv.join(", ")}
                    </td>
                    <td>
                      <span
                        className="claude-brain-pill"
                        data-active={PILL_DATA_ACTIVE[formatted.tone]}
                      >
                        {formatted.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {data && (
        <section className="claude-brain-panel" aria-label="Routing rules">
          <header className="claude-brain-panel-header">
            <div>
              <h2>Routing rules</h2>
              <p>
                task-type → preferred driver + fallback chain + injected args.
                Edit <code>~/.octogent-better/routing.json</code> to change.
              </p>
            </div>
          </header>
          <table className="claude-brain-table">
            <thead>
              <tr>
                <th scope="col">Task type</th>
                <th scope="col">Preferred</th>
                <th scope="col">Fallback chain</th>
                <th scope="col">Extra args</th>
              </tr>
            </thead>
            <tbody>
              {data.rules.map((rule) => (
                <tr key={rule.taskType}>
                  <td>
                    <code>{rule.taskType}</code>
                  </td>
                  <td>
                    <code>{rule.preferred}</code>
                  </td>
                  <td>
                    {rule.fallback.length === 0
                      ? "—"
                      : rule.fallback.map((f) => f).join(" → ")}
                  </td>
                  <td>
                    {rule.extraArgs.length === 0 ? "—" : (
                      <code style={{ fontSize: "0.74rem" }}>
                        {rule.extraArgs.join(" ")}
                      </code>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="claude-brain-panel" aria-label="Dispatch playground">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Dispatch playground</h2>
            <p>
              Picks a driver via the routing rules, probes health, and either
              previews the planned invocation (<code>dryRun</code>) or spawns
              the subprocess (60s timeout, 256kB output cap).
            </p>
          </div>
        </header>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            gap: "0.62rem",
          }}
        >
          <label style={{ display: "grid", gap: "0.18rem" }}>
            <span style={{ color: "#9eb0c8", fontSize: "0.76rem" }}>Task type</span>
            <select
              value={taskType}
              onChange={(e) => {
                setTaskType(e.target.value);
              }}
              disabled={isDispatching}
              style={{
                background: "#0b0d10",
                color: "#cbd0d6",
                border: "1px solid #2b2f36",
                padding: "0.38rem 0.5rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.78rem",
              }}
            >
              {(data?.rules ?? []).map((rule) => (
                <option key={rule.taskType} value={rule.taskType}>
                  {rule.taskType} → {rule.preferred}
                </option>
              ))}
              {(!data || data.rules.length === 0) && (
                <option value={taskType}>{taskType}</option>
              )}
            </select>
          </label>
          <label style={{ display: "grid", gap: "0.18rem" }}>
            <span style={{ color: "#9eb0c8", fontSize: "0.76rem" }}>cwd</span>
            <input
              type="text"
              value={cwd}
              onChange={(e) => {
                setCwd(e.target.value);
              }}
              disabled={isDispatching}
              style={{
                background: "#0b0d10",
                color: "#cbd0d6",
                border: "1px solid #2b2f36",
                padding: "0.38rem 0.5rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.78rem",
              }}
            />
          </label>
        </div>

        <label style={{ display: "grid", gap: "0.18rem" }}>
          <span style={{ color: "#9eb0c8", fontSize: "0.76rem" }}>Task input</span>
          <textarea
            value={taskInput}
            onChange={(e) => {
              setTaskInput(e.target.value);
            }}
            rows={4}
            disabled={isDispatching}
            style={{
              width: "100%",
              fontFamily: "ui-monospace, monospace",
              fontSize: "0.78rem",
              background: "#0b0d10",
              color: "#cbd0d6",
              border: "1px solid #2b2f36",
              padding: "0.5rem 0.62rem",
              resize: "vertical",
            }}
          />
        </label>

        <div className="claude-brain-panel-footer" style={{ display: "flex", gap: "0.6rem", alignItems: "center" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.4rem",
              color: "#9eb0c8",
              fontSize: "0.78rem",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(e) => {
                setDryRun(e.target.checked);
              }}
              disabled={isDispatching}
            />
            <span>dryRun (preview invocation only)</span>
          </label>
          <button
            type="button"
            className="claude-brain-refresh"
            onClick={() => {
              void handleDispatch();
            }}
            disabled={isDispatching || taskInput.length === 0}
          >
            {isDispatching ? "Dispatching…" : "Dispatch"}
          </button>
        </div>

        {dispatchError && (
          <div className="claude-brain-error" role="alert">
            Dispatch failed: {dispatchError}
          </div>
        )}
      </section>

      {dispatchResult && (
        <section className="claude-brain-panel" aria-label="Dispatch result">
          <header className="claude-brain-panel-header">
            <div>
              <h2>Last dispatch</h2>
              <p>
                <code>{dispatchResult.dispatch_id}</code> · task
                <code>{dispatchResult.taskType}</code>
                {dispatchResult.duration_ms !== null && (
                  <>
                    {" "}
                    · {dispatchResult.duration_ms}
                    ms
                  </>
                )}
              </p>
            </div>
            <span
              className="claude-brain-pill"
              data-active={dispatchResult.health.healthy ? "true" : "false"}
            >
              {formatHealth(dispatchResult.health).label}
            </span>
          </header>

          {dispatchResult.invocation && (
            <pre
              style={{
                background: "#0b0d10",
                border: "1px solid #2b2f36",
                color: "#cbd0d6",
                padding: "0.5rem 0.62rem",
                fontFamily: "ui-monospace, monospace",
                fontSize: "0.76rem",
                overflowX: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {dispatchResult.invocation.command}
              {dispatchResult.invocation.args.length > 0 &&
                ` ${dispatchResult.invocation.args
                  .map((a) => (a.includes(" ") ? JSON.stringify(a) : a))
                  .join(" ")}`}
              {`\n# cwd: ${dispatchResult.invocation.cwd}`}
              {dispatchResult.invocation.envFlags.length > 0 &&
                `\n# env required: ${dispatchResult.invocation.envFlags.join(", ")}`}
            </pre>
          )}

          {(stdoutChunks.length > 0 || stderrChunks.length > 0) && (
            <details open>
              <summary style={{ color: "#9eb0c8", cursor: "pointer", fontSize: "0.8rem" }}>
                Subprocess output
              </summary>
              {stdoutChunks.length > 0 && (
                <pre
                  style={{
                    background: "#0b0d10",
                    border: "1px solid #2b2f36",
                    color: "#cbd0d6",
                    padding: "0.5rem 0.62rem",
                    fontSize: "0.74rem",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {stdoutChunks}
                </pre>
              )}
              {stderrChunks.length > 0 && (
                <pre
                  style={{
                    background: "#1a1010",
                    border: "1px solid #5a2d2d",
                    color: "#ffb4b4",
                    padding: "0.5rem 0.62rem",
                    fontSize: "0.74rem",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {stderrChunks}
                </pre>
              )}
            </details>
          )}
        </section>
      )}
    </section>
  );
};
