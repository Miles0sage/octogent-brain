import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlanGate } from "../src/components/PlanGate";

const samplePlan = {
  agent_name: "bd-builder-agent",
  files_to_change: [
    "/root/octogent/apps/web/src/components/PlanGate.tsx",
    "/root/octogent/apps/web/tests/PlanGate.test.tsx",
  ],
  test_plan: "Run vitest filter PlanGate, assert all 6 cases pass.",
  rollback_plan: "git checkout HEAD -- apps/web/src/components/PlanGate.tsx",
  estimated_loc: 120,
};

describe("PlanGate", () => {
  it("renders agent name, file list, plans, and LoC when a plan is provided", () => {
    render(
      <PlanGate
        plan={samplePlan}
        status="awaiting"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    expect(screen.getByText("bd-builder-agent")).toBeInTheDocument();
    expect(screen.getByText(/awaiting approval/i)).toBeInTheDocument();
    expect(
      screen.getByText("/root/octogent/apps/web/src/components/PlanGate.tsx"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("/root/octogent/apps/web/tests/PlanGate.test.tsx"),
    ).toBeInTheDocument();
    expect(screen.getByText(samplePlan.test_plan)).toBeInTheDocument();
    expect(screen.getByText(samplePlan.rollback_plan)).toBeInTheDocument();
    expect(screen.getByText(/120/)).toBeInTheDocument();
  });

  it("renders the empty state when plan is null", () => {
    render(
      <PlanGate
        plan={null}
        status="awaiting"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    expect(screen.getByText(/no plan pending/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve plan/i })).toBeNull();
  });

  it("calls onApprove exactly once when the approve button is clicked", () => {
    const onApprove = vi.fn();

    render(
      <PlanGate
        plan={samplePlan}
        status="awaiting"
        onApprove={onApprove}
        onReject={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /approve plan/i }));

    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("calls onReject with the textarea reason when reject is submitted", () => {
    const onReject = vi.fn();

    render(
      <PlanGate
        plan={samplePlan}
        status="awaiting"
        onApprove={() => {}}
        onReject={onReject}
      />,
    );

    // Open the inline reject form.
    fireEvent.click(screen.getByRole("button", { name: /^reject/i }));

    const textarea = screen.getByRole("textbox", { name: /rejection reason/i });
    fireEvent.change(textarea, { target: { value: "Touches forbidden file." } });

    fireEvent.click(screen.getByRole("button", { name: /confirm reject/i }));

    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onReject).toHaveBeenCalledWith("Touches forbidden file.");
  });

  it("dims the buttons and shows a checkmark when status is approved", () => {
    render(
      <PlanGate
        plan={samplePlan}
        status="approved"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    const approveButton = screen.getByRole("button", { name: /approve plan/i });
    const rejectButton = screen.getByRole("button", { name: /^reject/i });

    expect(approveButton).toBeDisabled();
    expect(rejectButton).toBeDisabled();
    expect(screen.getByLabelText(/plan approved/i)).toBeInTheDocument();
  });

  it("shows the rejection reason when status is rejected", () => {
    render(
      <PlanGate
        plan={samplePlan}
        status="rejected"
        rejectionReason="Plan touches a forbidden path"
        onApprove={() => {}}
        onReject={() => {}}
      />,
    );

    expect(screen.getByLabelText(/plan rejected/i)).toBeInTheDocument();
    expect(screen.getByText("Plan touches a forbidden path")).toBeInTheDocument();
  });
});
