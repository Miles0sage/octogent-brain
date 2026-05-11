import { useState } from "react";

export interface PlanGatePlan {
  agent_name: string;
  files_to_change: string[];
  test_plan: string;
  rollback_plan: string;
  estimated_loc: number;
}

export type PlanGateStatus = "awaiting" | "approved" | "rejected";

export interface PlanGateProps {
  plan: PlanGatePlan | null;
  status: PlanGateStatus;
  rejectionReason?: string;
  onApprove: () => void;
  onReject: (reason: string) => void;
}

/**
 * Plan-approval gate per Anthropic "agent-teams" pattern
 * (https://code.claude.com/docs/en/agent-teams, fetched 2026-05-11).
 *
 * Teammates work in `permissionMode: plan` and emit a structured plan; the
 * lead approves or rejects before any Edit/Write is permitted.
 */
export const PlanGate = ({
  plan,
  status,
  rejectionReason,
  onApprove,
  onReject,
}: PlanGateProps) => {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [reasonDraft, setReasonDraft] = useState("");

  if (plan === null) {
    return (
      <section
        className="claude-brain-panel"
        aria-label="Plan approval gate"
        data-empty="true"
      >
        <header className="claude-brain-panel-header">
          <div>
            <h2>Plan-approval gate</h2>
            <p>No plan pending</p>
          </div>
        </header>
      </section>
    );
  }

  const disabled = status !== "awaiting";

  return (
    <section className="claude-brain-panel" aria-label="Plan approval gate">
      <header className="claude-brain-panel-header">
        <div>
          <h2>{plan.agent_name}</h2>
          <p>
            <span
              className="claude-brain-pill"
              data-active={status === "awaiting" ? "true" : "false"}
            >
              {status === "awaiting"
                ? "Plan awaiting approval"
                : status === "approved"
                  ? "Plan approved"
                  : "Plan rejected"}
            </span>
          </p>
        </div>
        <span
          className="claude-brain-pill"
          data-active="false"
          aria-label={`Estimated lines of code: ${plan.estimated_loc}`}
        >
          ~{plan.estimated_loc} LoC
        </span>
      </header>

      <div className="claude-brain-card-body">
        <div>
          <dt>files</dt>
          <dd>
            <ul style={{ fontFamily: "monospace", paddingLeft: "1rem", margin: 0 }}>
              {plan.files_to_change.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>test plan</dt>
          <dd>
            <pre
              style={{ whiteSpace: "pre-wrap", margin: 0 }}
              className="claude-brain-note"
            >
              {plan.test_plan}
            </pre>
          </dd>
        </div>
        <div>
          <dt>rollback plan</dt>
          <dd>
            <pre
              style={{ whiteSpace: "pre-wrap", margin: 0 }}
              className="claude-brain-note"
            >
              {plan.rollback_plan}
            </pre>
          </dd>
        </div>
      </div>

      {status === "approved" && (
        <div
          className="claude-brain-note"
          aria-label="Plan approved"
          role="status"
        >
          <span aria-hidden="true">✓</span> Plan approved
        </div>
      )}

      {status === "rejected" && (
        <div
          className="claude-brain-error"
          aria-label="Plan rejected"
          role="alert"
        >
          <span aria-hidden="true">✗</span> Plan rejected
          {rejectionReason !== undefined && rejectionReason.length > 0 && (
            <pre style={{ whiteSpace: "pre-wrap", margin: "0.5rem 0 0" }}>
              {rejectionReason}
            </pre>
          )}
        </div>
      )}

      <footer
        className="claude-brain-panel-footer"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
      >
        <button
          className="claude-brain-refresh"
          type="button"
          onClick={onApprove}
          disabled={disabled}
          data-variant="primary"
        >
          Approve plan
        </button>
        <button
          className="claude-brain-refresh"
          type="button"
          onClick={() => setShowRejectForm((prev) => !prev)}
          disabled={disabled}
          data-variant="secondary"
        >
          Reject…
        </button>
      </footer>

      {showRejectForm && !disabled && (
        <div className="claude-brain-note">
          <label
            htmlFor="plan-gate-reject-reason"
            style={{ display: "block", marginBottom: "0.25rem" }}
          >
            Rejection reason
          </label>
          <textarea
            id="plan-gate-reject-reason"
            aria-label="Rejection reason"
            value={reasonDraft}
            onChange={(event) => setReasonDraft(event.target.value)}
            rows={3}
            style={{ width: "100%", fontFamily: "inherit" }}
          />
          <button
            className="claude-brain-refresh"
            type="button"
            onClick={() => {
              onReject(reasonDraft);
              setShowRejectForm(false);
              setReasonDraft("");
            }}
            data-variant="danger"
          >
            Confirm reject
          </button>
        </div>
      )}
    </section>
  );
};
