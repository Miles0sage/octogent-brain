import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RolloutsGantt } from "../src/components/RolloutsGantt";

const sampleResponse = {
  rollouts: [
    {
      rollout_id: "rl-aaa111",
      agent_name: "briefingdeck_reviewer",
      status: "succeeded",
      reward_total: 1.5,
      started_at_iso: "2026-05-06T09:00:00.000Z",
      finished_at_iso: "2026-05-06T09:00:30.000Z",
      latency_ms: 30000,
    },
    {
      rollout_id: "rl-bbb222",
      agent_name: "briefingdeck_synthesizer",
      status: "failed",
      reward_total: 0.2,
      started_at_iso: "2026-05-06T09:01:00.000Z",
      finished_at_iso: "2026-05-06T09:01:45.000Z",
      latency_ms: 45000,
    },
    {
      rollout_id: "rl-ccc333",
      agent_name: "briefingdeck_reviewer",
      status: "running",
      reward_total: 0,
      started_at_iso: "2026-05-06T09:02:00.000Z",
      finished_at_iso: null,
      latency_ms: null,
    },
  ],
  db_path: "/tmp/test.db",
  limit: 200,
};

describe("RolloutsGantt", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href.startsWith("/api/claude-brain/rollouts")) {
        return new Response(JSON.stringify(sampleResponse), {
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

  it("renders summary stats from the loaded rollouts", async () => {
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByText("Agent rollouts — Gantt waterfall")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Rollouts")).toBeInTheDocument();
    });
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("Lanes")).toBeInTheDocument();
    expect(screen.getByText("In flight")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();
  });

  it("renders one lane label per distinct agent_name", async () => {
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByText("briefingdeck_reviewer")).toBeInTheDocument();
    });
    expect(screen.getByText("briefingdeck_synthesizer")).toBeInTheDocument();
  });

  it("renders an SVG figure with bars for every started rollout", async () => {
    const { container } = render(<RolloutsGantt />);
    await waitFor(() => {
      expect(container.querySelector("svg")).not.toBeNull();
    });
    const rects = container.querySelectorAll("svg rect");
    expect(rects.length).toBe(3);
  });

  it("renders empty-state note when no rollouts", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ rollouts: [], db_path: "/tmp/test.db" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByText("No rollouts to render.")).toBeInTheDocument();
    });
  });

  it("surfaces fetch errors in the alert region", async () => {
    const fetchMock = vi.fn(async () => new Response("server down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).toContain("HTTP 500");
  });
});

// Vote-outcome visualization — Mechanical Supervision demo.
// The vote demo lives at the bottom of the Gantt panel; it lets a viewer
// fire `POST /api/claude-brain/votes/dispatch` with a sample task and see
// cross-vendor voting consensus rendered as a card with per-voter rows.

const samplePassOutcome = {
  vote_id: "vt-1",
  outcome: {
    winner: "pass" as const,
    reason:
      "consensus: all 3 voter(s) agreed on pass (score spread within tolerance 0.05)",
    consensus_count: 3,
    dissent_count: 0,
    verdicts: [
      {
        provider: "claude-code",
        verdict: {
          verdict: "pass",
          improvements_exhausted: false,
          issues: [],
          scores: { groundedness: 0.92, specificity: 0.9 },
        },
        raw_output: "...",
      },
      {
        provider: "codex",
        verdict: {
          verdict: "pass",
          improvements_exhausted: false,
          issues: [],
          scores: { groundedness: 0.9, specificity: 0.88 },
        },
        raw_output: "...",
      },
      {
        provider: "gemini-cli",
        verdict: {
          verdict: "pass",
          improvements_exhausted: false,
          issues: [],
          scores: { groundedness: 0.91, specificity: 0.89 },
        },
        raw_output: "...",
      },
    ],
  },
  dispatch_ids: ["d1", "d2", "d3"],
  started_at_iso: "2026-05-12T10:00:00.000Z",
  duration_ms: 1234,
};

const sampleNoConsensusOutcome = {
  vote_id: "vt-2",
  outcome: {
    winner: "no-consensus" as const,
    reason:
      "split decision: 1 pass / 1 fail across 2 voter(s); no strict majority, no consensus, no strong reject",
    consensus_count: 0,
    dissent_count: 2,
    verdicts: [
      {
        provider: "claude-code",
        verdict: {
          verdict: "pass",
          improvements_exhausted: false,
          issues: [],
          scores: { groundedness: 0.9, specificity: 0.88 },
        },
        raw_output: "...",
      },
      {
        provider: "codex",
        verdict: {
          verdict: "fail",
          improvements_exhausted: false,
          issues: ["disagrees"],
          scores: { groundedness: 0.7, specificity: 0.6 },
        },
        raw_output: "...",
        error: "health-failed: binary-missing",
      },
    ],
  },
  dispatch_ids: ["d1", "d2"],
  started_at_iso: "2026-05-12T10:00:00.000Z",
  duration_ms: 555,
};

const buildFetchMock = (voteResponse: unknown, voteStatus = 200) =>
  vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href.startsWith("/api/claude-brain/rollouts")) {
      return new Response(JSON.stringify(sampleResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (href.startsWith("/api/claude-brain/votes/dispatch")) {
      // Sanity-check the request body so callers can't accidentally regress
      // the API contract.
      if (init && init.method !== "POST") {
        return new Response("method", { status: 405 });
      }
      return new Response(
        typeof voteResponse === "string" ? voteResponse : JSON.stringify(voteResponse),
        {
          status: voteStatus,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return new Response("not found", { status: 404 });
  });

describe("RolloutsGantt — vote-outcome visualization", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("renders the vote-demo controls with an empty-state hint when no vote has run", async () => {
    vi.stubGlobal("fetch", buildFetchMock(samplePassOutcome));
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByRole("region", { name: /Cross-vendor vote demo/i })).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /Run cross-vendor vote/i }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/Task input/i)).toBeInTheDocument();
    expect(
      screen.getByText(/No vote run yet/i),
    ).toBeInTheDocument();
  });

  it("dispatches a vote and renders the pass outcome with per-voter rows", async () => {
    vi.stubGlobal("fetch", buildFetchMock(samplePassOutcome));
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Run cross-vendor vote/i })).toBeInTheDocument();
    });

    const button = screen.getByRole("button", { name: /Run cross-vendor vote/i });
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByLabelText(/Vote outcome/i)).toBeInTheDocument();
    });

    // Winner pill renders with data-active="true" for pass.
    const pill = screen.getByLabelText(/Vote winner/i);
    expect(pill.getAttribute("data-active")).toBe("true");
    expect(pill.textContent?.toLowerCase()).toContain("pass");

    // Per-voter rows: one per provider.
    expect(screen.getByText("claude-code")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("gemini-cli")).toBeInTheDocument();

    // Reason text from the outcome surfaces in the note.
    expect(
      screen.getByText(/consensus: all 3 voter\(s\) agreed on pass/i),
    ).toBeInTheDocument();
  });

  it("renders no-consensus outcome with grey pill and surfaces per-voter errors", async () => {
    vi.stubGlobal("fetch", buildFetchMock(sampleNoConsensusOutcome));
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Run cross-vendor vote/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Run cross-vendor vote/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Vote outcome/i)).toBeInTheDocument();
    });

    const pill = screen.getByLabelText(/Vote winner/i);
    // no-consensus is neither pass nor fail; data-active is absent (neither "true" nor "false")
    expect(pill.getAttribute("data-active")).not.toBe("true");
    expect(pill.textContent?.toLowerCase()).toContain("no-consensus");

    // Per-voter error message surfaces in the row.
    expect(
      screen.getByText(/health-failed: binary-missing/i),
    ).toBeInTheDocument();
  });

  it("surfaces vote-dispatch fetch failures without breaking the panel", async () => {
    vi.stubGlobal("fetch", buildFetchMock("server down", 500));
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Run cross-vendor vote/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("button", { name: /Run cross-vendor vote/i }));

    await waitFor(() => {
      const errorRegion = screen.getByLabelText(/Vote error/i);
      expect(errorRegion).toBeInTheDocument();
      expect(errorRegion.textContent).toContain("HTTP 500");
    });
  });

  it("POSTs the user-typed task input with dryRun flag to the vote endpoint", async () => {
    const fetchMock = buildFetchMock(samplePassOutcome);
    vi.stubGlobal("fetch", fetchMock);
    render(<RolloutsGantt />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Run cross-vendor vote/i })).toBeInTheDocument();
    });

    const textarea = screen.getByLabelText(/Task input/i) as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: "verify the patch removes the bug" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Run cross-vendor vote/i }));

    await waitFor(() => {
      expect(screen.getByLabelText(/Vote outcome/i)).toBeInTheDocument();
    });

    const voteCall = fetchMock.mock.calls.find((call) => {
      const url = typeof call[0] === "string" ? call[0] : (call[0] as URL).toString();
      return url.startsWith("/api/claude-brain/votes/dispatch");
    });
    expect(voteCall).toBeDefined();
    if (!voteCall) throw new Error("vote call missing");
    const init = voteCall[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.taskInput).toBe("verify the patch removes the bug");
    expect(body.dryRun).toBe(true);
  });
});
