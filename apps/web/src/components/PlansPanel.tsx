import { useCallback, useState } from "react";

import { PlanGate, type PlanGatePlan, type PlanGateStatus } from "./PlanGate";

type PendingPlan = {
  id: string;
  plan: PlanGatePlan;
  status: PlanGateStatus;
  rejectionReason?: string;
};

// Demo seed. Real plans land here when `permissionMode: plan` agents emit
// structured plans via a future POST /api/claude-brain/plans endpoint;
// for now this panel proves the gate UX end-to-end with seed data so
// hackathon judges can see approve/reject in action.
const SEED_PLANS: PendingPlan[] = [
  {
    id: "plan-demo-1",
    plan: {
      agent_name: "bd-builder-agent",
      files_to_change: [
        "briefingdeck/agents/reviewer.py",
        "briefingdeck/agents/loop.py",
        "tests/test_synth_review.py",
      ],
      test_plan:
        "Run `pytest tests/test_synth_review.py -v` after each edit. 159 tests must stay green.",
      rollback_plan:
        "`git diff HEAD~1 -- briefingdeck/agents/ tests/test_synth_review.py | git apply -R` reverts cleanly.",
      estimated_loc: 110,
    },
    status: "awaiting",
  },
  {
    id: "plan-demo-2",
    plan: {
      agent_name: "bd-synthesizer-agent",
      files_to_change: ["briefingdeck/agents/synthesizer.py"],
      test_plan: "Re-run synth golden set against fixtures/notebook_smoke.json.",
      rollback_plan: "git revert HEAD",
      estimated_loc: 40,
    },
    status: "approved",
  },
];

export const PlansPanel = () => {
  const [plans, setPlans] = useState<PendingPlan[]>(SEED_PLANS);

  const handleApprove = useCallback((id: string) => {
    setPlans((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: "approved" } : p)),
    );
  }, []);

  const handleReject = useCallback((id: string, reason: string) => {
    setPlans((prev) =>
      prev.map((p) =>
        p.id === id ? { ...p, status: "rejected", rejectionReason: reason } : p,
      ),
    );
  }, []);

  const pendingCount = plans.filter((p) => p.status === "awaiting").length;
  const approvedCount = plans.filter((p) => p.status === "approved").length;
  const rejectedCount = plans.filter((p) => p.status === "rejected").length;

  return (
    <section className="claude-brain-view" aria-label="Plan approval gate">
      <section className="claude-brain-panel" aria-label="Pending plans">
        <header className="claude-brain-panel-header">
          <div>
            <h2>Plan-approval gate</h2>
            <p>
              Per Anthropic's <code>agent-teams</code> "Require plan approval"
              pattern. Teammates work read-only until the lead approves each
              plan. Seed data shown; live wiring lands when{" "}
              <code>POST /api/claude-brain/plans</code> ships.
            </p>
          </div>
        </header>

        <div className="claude-brain-summary-row" aria-label="Plan-gate stats">
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Awaiting</span>
            <span className="claude-brain-stat-value">{pendingCount}</span>
          </div>
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Approved</span>
            <span className="claude-brain-stat-value">{approvedCount}</span>
          </div>
          <div className="claude-brain-stat">
            <span className="claude-brain-stat-label">Rejected</span>
            <span className="claude-brain-stat-value">{rejectedCount}</span>
          </div>
        </div>
      </section>

      {plans.map((entry) => (
        <PlanGate
          key={entry.id}
          plan={entry.plan}
          status={entry.status}
          {...(entry.rejectionReason !== undefined
            ? { rejectionReason: entry.rejectionReason }
            : {})}
          onApprove={() => {
            handleApprove(entry.id);
          }}
          onReject={(reason) => {
            handleReject(entry.id, reason);
          }}
        />
      ))}
    </section>
  );
};
