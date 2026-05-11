import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
