import { useCallback, useEffect, useMemo, useState } from "react";

interface FixtureSummary {
  name: string;
  label: string;
  description: string;
}

interface FixturesResponse {
  fixtures: FixtureSummary[];
  source_path: string;
  note?: string;
}

interface FixtureDetail extends FixtureSummary {
  raw_reviewer_output: string;
  prior_iterations: Array<{ verdict_label: string; gate_passed: boolean }>;
  expected_outcome: {
    parsed_verdict: boolean;
    gate_passes: boolean;
    loop_action: string;
  };
}

interface ParsedVerdict {
  verdict: "pass" | "fail";
  improvements_exhausted: boolean;
  issues: string[];
  scores: { groundedness: number; specificity: number };
}

interface GateDecision {
  passes: boolean;
  reason: string;
}

interface LoopDecision {
  action: "continue" | "approve" | "max" | "fp";
}

interface ReviewGateResponse {
  parsed_verdict: ParsedVerdict | null;
  gate_decision: GateDecision | null;
  loop_decision: LoopDecision;
  iterations_considered: number;
  gate_config: { groundednessThreshold: number; specificityThreshold: number };
  loop_config: { maxIterations: number; falsePositiveTerminationThreshold: number };
}

const fetchFixtures = async (): Promise<FixturesResponse> => {
  const response = await fetch("/api/claude-brain/review-fixtures");
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as FixturesResponse;
};

const fetchFixtureDetail = async (name: string): Promise<FixtureDetail> => {
  const response = await fetch(`/api/claude-brain/review-fixtures/${name}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as FixtureDetail;
};

const runGate = async (
  rawOutput: string,
  priorIterations: Array<{ verdict_label: string; gate_passed: boolean }>,
): Promise<ReviewGateResponse> => {
  const response = await fetch("/api/claude-brain/review-gate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      raw_reviewer_output: rawOutput,
      prior_iterations: priorIterations,
    }),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as ReviewGateResponse;
};

const ACTION_LABELS: Record<LoopDecision["action"], string> = {
  approve: "approve · loop exits",
  continue: "continue · iterate",
  max: "max · cap reached",
  fp: "fp-terminated · rubber-stamp pattern",
};

const ACTION_DATA_ACTIVE: Record<LoopDecision["action"], string> = {
  approve: "true",
  continue: "false",
  max: "false",
  fp: "false",
};

export const VerifyLoopPanel = () => {
  const [fixtures, setFixtures] = useState<FixtureSummary[]>([]);
  const [fixturesNote, setFixturesNote] = useState<string | null>(null);
  const [fixturesError, setFixturesError] = useState<string | null>(null);
  const [activeFixture, setActiveFixture] = useState<FixtureDetail | null>(null);
  const [rawInput, setRawInput] = useState("");
  const [priorIterations, setPriorIterations] = useState<
    Array<{ verdict_label: string; gate_passed: boolean }>
  >([]);
  const [result, setResult] = useState<ReviewGateResponse | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const next = await fetchFixtures();
        setFixtures(next.fixtures);
        setFixturesNote(next.note ?? null);
      } catch (err) {
        setFixturesError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const loadFixture = useCallback(async (name: string) => {
    try {
      const detail = await fetchFixtureDetail(name);
      setActiveFixture(detail);
      setRawInput(detail.raw_reviewer_output);
      setPriorIterations(detail.prior_iterations);
      setResult(null);
      setRunError(null);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleRun = useCallback(async () => {
    setIsRunning(true);
    setRunError(null);
    try {
      const next = await runGate(rawInput, priorIterations);
      setResult(next);
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, [rawInput, priorIterations]);

  const handleClear = useCallback(() => {
    setActiveFixture(null);
    setRawInput("");
    setPriorIterations([]);
    setResult(null);
    setRunError(null);
  }, []);

  const expectedMatches = useMemo(() => {
    if (!activeFixture || !result) return null;
    const parsedMatch = (result.parsed_verdict !== null) === activeFixture.expected_outcome.parsed_verdict;
    const gateMatch =
      activeFixture.expected_outcome.gate_passes ===
      (result.gate_decision?.passes ?? false);
    const actionMatch =
      activeFixture.expected_outcome.loop_action === result.loop_decision.action;
    return { parsedMatch, gateMatch, actionMatch };
  }, [activeFixture, result]);

  return (
    <section className="claude-brain-view" aria-label="Verify-loop playground">
      <section className="claude-brain-panel" aria-label="Verdict-gate runner">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Verify-loop playground</h2>
            <p>
              Pipe raw reviewer output through <code>parseReviewerVerdict</code>{" "}
              → <code>evaluateVerdict</code> → <code>decideNext</code>. Catches
              the rubber-stamp pattern Anthropic flagged in the 2026-03-24
              harness post: reviewer claims <code>"pass"</code> but its own
              scores fall below 0.85. Fixtures pre-recorded — no live API spend.
            </p>
          </div>
          <button
            className="claude-brain-refresh"
            type="button"
            onClick={handleClear}
            disabled={isRunning}
          >
            Clear
          </button>
        </header>

        {fixturesError && (
          <div className="claude-brain-error" role="alert">
            Failed to load fixtures: {fixturesError}
          </div>
        )}

        {fixturesNote && <div className="claude-brain-note">{fixturesNote}</div>}

        <div className="claude-brain-summary-row" aria-label="Fixture pickers">
          {fixtures.length === 0 && !fixturesError && (
            <div className="claude-brain-note">No fixtures loaded.</div>
          )}
          {fixtures.map((f) => (
            <button
              key={f.name}
              type="button"
              className="claude-brain-stat"
              style={{ cursor: "pointer", textAlign: "left" }}
              onClick={() => {
                void loadFixture(f.name);
              }}
              disabled={isRunning}
              data-active={activeFixture?.name === f.name ? "true" : "false"}
            >
              <span className="claude-brain-stat-label">{f.name}</span>
              <span className="claude-brain-stat-value" style={{ fontSize: "0.78rem" }}>
                {f.label}
              </span>
            </button>
          ))}
        </div>

        {activeFixture && (
          <div className="claude-brain-note">
            {activeFixture.description}
            {activeFixture.prior_iterations.length > 0 && (
              <>
                {" "}
                Prior iterations seeded: {activeFixture.prior_iterations.length}.
              </>
            )}
          </div>
        )}

        <label
          htmlFor="verify-loop-input"
          style={{ color: "#9eb0c8", fontSize: "0.78rem" }}
        >
          Raw reviewer output (the verdict-gate parses the last JSON object)
        </label>
        <textarea
          id="verify-loop-input"
          value={rawInput}
          onChange={(e) => {
            setRawInput(e.target.value);
          }}
          rows={12}
          spellCheck={false}
          style={{
            width: "100%",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.76rem",
            background: "#0b0d10",
            color: "#cbd0d6",
            border: "1px solid #2b2f36",
            padding: "0.5rem 0.62rem",
            resize: "vertical",
          }}
        />

        <div className="claude-brain-panel-footer">
          <button
            type="button"
            className="claude-brain-refresh"
            onClick={() => {
              void handleRun();
            }}
            disabled={isRunning || rawInput.length === 0}
          >
            {isRunning ? "Running…" : "Run gate"}
          </button>
        </div>

        {runError && (
          <div className="claude-brain-error" role="alert">
            Run failed: {runError}
          </div>
        )}
      </section>

      {result && (
        <section className="claude-brain-panel" aria-label="Verdict-gate result">
          <header className="claude-brain-panel-header">
            <div>
              <h2>Gate decision</h2>
              <p>
                Iterations considered: {result.iterations_considered} · thresholds
                groundedness ≥ {result.gate_config.groundednessThreshold}, specificity
                ≥ {result.gate_config.specificityThreshold} · loop max{" "}
                {result.loop_config.maxIterations}, fp threshold{" "}
                {result.loop_config.falsePositiveTerminationThreshold}
              </p>
            </div>
            <span
              className="claude-brain-pill"
              data-active={ACTION_DATA_ACTIVE[result.loop_decision.action]}
            >
              {ACTION_LABELS[result.loop_decision.action]}
            </span>
          </header>

          <div className="claude-brain-summary-row">
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Parsed verdict</span>
              <span className="claude-brain-stat-value">
                {result.parsed_verdict ? result.parsed_verdict.verdict : "—"}
              </span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Groundedness</span>
              <span className="claude-brain-stat-value">
                {result.parsed_verdict
                  ? result.parsed_verdict.scores.groundedness.toFixed(2)
                  : "—"}
              </span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Specificity</span>
              <span className="claude-brain-stat-value">
                {result.parsed_verdict
                  ? result.parsed_verdict.scores.specificity.toFixed(2)
                  : "—"}
              </span>
            </div>
            <div className="claude-brain-stat">
              <span className="claude-brain-stat-label">Gate</span>
              <span className="claude-brain-stat-value">
                {result.gate_decision
                  ? result.gate_decision.passes
                    ? "PASS"
                    : "BLOCK"
                  : "n/a"}
              </span>
            </div>
          </div>

          {result.gate_decision && (
            <div className="claude-brain-note">
              Reason: {result.gate_decision.reason}
            </div>
          )}

          {result.parsed_verdict === null && (
            <div className="claude-brain-error" role="alert">
              parseReviewerVerdict returned null — no balanced-JSON object found
              in the input. The loop treats a missing verdict as implicit fail.
            </div>
          )}

          {result.parsed_verdict && result.parsed_verdict.issues.length > 0 && (
            <details>
              <summary
                style={{
                  color: "#9eb0c8",
                  cursor: "pointer",
                  fontSize: "0.82rem",
                }}
              >
                Reviewer-reported issues ({result.parsed_verdict.issues.length})
              </summary>
              <ul style={{ color: "#b8c2d1", fontSize: "0.78rem" }}>
                {result.parsed_verdict.issues.map((issue, idx) => (
                  <li key={`${idx}-${issue.slice(0, 24)}`}>{issue}</li>
                ))}
              </ul>
            </details>
          )}

          {expectedMatches && (
            <footer className="claude-brain-panel-footer">
              Fixture expectations met:{" "}
              {expectedMatches.parsedMatch ? "✓ parsed" : "✗ parsed"} ·{" "}
              {expectedMatches.gateMatch ? "✓ gate" : "✗ gate"} ·{" "}
              {expectedMatches.actionMatch ? "✓ action" : "✗ action"}
            </footer>
          )}
        </section>
      )}
    </section>
  );
};
