import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { VerifyLoopPanel } from "../src/components/VerifyLoopPanel";

const FIXTURES_LIST_RESPONSE = {
  fixtures: [
    { name: "clean-pass", label: "Clean pass", description: "high scores" },
    {
      name: "rubber-stamp",
      label: "Rubber-stamp",
      description: "claims pass, scores fail",
    },
  ],
  source_path: "/tmp/fixtures",
};

const FIXTURE_RUBBER_STAMP = {
  name: "rubber-stamp",
  label: "Rubber-stamp",
  description: "Reviewer claims pass but groundedness 0.62 < 0.85",
  raw_reviewer_output:
    '{"verdict": "pass", "improvements_exhausted": false, "issues": ["MAJOR"], "scores": {"groundedness": 0.62, "specificity": 0.88}}',
  prior_iterations: [],
  expected_outcome: { parsed_verdict: true, gate_passes: false, loop_action: "continue" },
};

const GATE_RESPONSE_RUBBER_STAMP = {
  parsed_verdict: {
    verdict: "pass",
    improvements_exhausted: false,
    issues: ["MAJOR retriever.py:88 chunk 12 not in source set"],
    scores: { groundedness: 0.62, specificity: 0.88 },
  },
  gate_decision: {
    passes: false,
    reason:
      "reviewer wrote pass but groundedness 0.62 < threshold 0.85 — rubber-stamp caught",
  },
  loop_decision: { action: "continue" },
  iterations_considered: 1,
  gate_config: { groundednessThreshold: 0.85, specificityThreshold: 0.85 },
  loop_config: { maxIterations: 5, falsePositiveTerminationThreshold: 0.5 },
};

describe("VerifyLoopPanel", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "/api/claude-brain/review-fixtures") {
        return new Response(JSON.stringify(FIXTURES_LIST_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href === "/api/claude-brain/review-fixtures/rubber-stamp") {
        return new Response(JSON.stringify(FIXTURE_RUBBER_STAMP), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href === "/api/claude-brain/review-gate" && init?.method === "POST") {
        return new Response(JSON.stringify(GATE_RESPONSE_RUBBER_STAMP), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("lists fixtures on mount", async () => {
    render(<VerifyLoopPanel />);
    await waitFor(() => {
      expect(screen.getByText("clean-pass")).toBeInTheDocument();
    });
    expect(screen.getByText("rubber-stamp")).toBeInTheDocument();
  });

  it("loads fixture detail into the textarea on click", async () => {
    render(<VerifyLoopPanel />);
    await waitFor(() => {
      expect(screen.getByText("rubber-stamp")).toBeInTheDocument();
    });
    const rubberStampButton = screen.getByText("rubber-stamp").closest("button");
    expect(rubberStampButton).not.toBeNull();
    if (rubberStampButton) {
      fireEvent.click(rubberStampButton);
    }
    await waitFor(() => {
      const textarea = screen.getByLabelText(
        /Raw reviewer output/,
      ) as HTMLTextAreaElement;
      expect(textarea.value).toContain('"groundedness": 0.62');
    });
  });

  it("runs the gate and renders BLOCK + continue when scores fall below threshold", async () => {
    render(<VerifyLoopPanel />);
    await waitFor(() => {
      expect(screen.getByText("rubber-stamp")).toBeInTheDocument();
    });
    const rubberStampButton = screen.getByText("rubber-stamp").closest("button");
    if (rubberStampButton) {
      fireEvent.click(rubberStampButton);
    }
    await waitFor(() => {
      const textarea = screen.getByLabelText(
        /Raw reviewer output/,
      ) as HTMLTextAreaElement;
      expect(textarea.value.length).toBeGreaterThan(0);
    });

    const runButton = screen.getByRole("button", { name: /Run gate/ });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(screen.getByText("BLOCK")).toBeInTheDocument();
    });
    expect(screen.getByText(/continue · iterate/)).toBeInTheDocument();
    expect(screen.getByText(/rubber-stamp caught/)).toBeInTheDocument();
  });

  it("shows fixture-expectation match indicators after a run", async () => {
    render(<VerifyLoopPanel />);
    await waitFor(() => {
      expect(screen.getByText("rubber-stamp")).toBeInTheDocument();
    });
    const rubberStampButton = screen.getByText("rubber-stamp").closest("button");
    if (rubberStampButton) {
      fireEvent.click(rubberStampButton);
    }
    await waitFor(() => {
      const textarea = screen.getByLabelText(
        /Raw reviewer output/,
      ) as HTMLTextAreaElement;
      expect(textarea.value.length).toBeGreaterThan(0);
    });
    fireEvent.click(screen.getByRole("button", { name: /Run gate/ }));
    await waitFor(() => {
      expect(screen.getByText(/Fixture expectations met/)).toBeInTheDocument();
    });
    expect(screen.getByText(/✓ parsed/)).toBeInTheDocument();
    expect(screen.getByText(/✓ gate/)).toBeInTheDocument();
    expect(screen.getByText(/✓ action/)).toBeInTheDocument();
  });

  it("surfaces fixture-load errors", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<VerifyLoopPanel />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/HTTP 500/);
  });
});
