// Lane-3 cost-cap UX wave 2 — stat-tile component tests.
//
// 4 color states (slate / amber / red+pulse), tooltip reset time render,
// 404 graceful fallback, $-formatter sanity.

import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CostCapTile } from "../src/components/CostCapTile";
import { formatUsd } from "../src/lib/cost-cap-client";

const stubFetch = (
  resp: Partial<Response> | "404",
): ReturnType<typeof vi.spyOn> => {
  const fetchImpl = vi.fn(async (): Promise<Response> => {
    if (resp === "404") {
      return new Response("not found", { status: 404 }) as Response;
    }
    return new Response(resp.body as BodyInit, {
      status: resp.status ?? 200,
      headers: { "Content-Type": "application/json" },
    }) as Response;
  });
  return vi.spyOn(globalThis, "fetch").mockImplementation(fetchImpl as never);
};

describe("formatUsd", () => {
  it("renders 2-decimal $ amounts", () => {
    expect(formatUsd(3.4)).toBe("$3.40");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(20)).toBe("$20.00");
  });
});

describe("CostCapTile", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;
  beforeEach(() => {
    fetchSpy = null;
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    fetchSpy = null;
  });

  it("renders slate (under 50%) state with formatted $ amount", async () => {
    fetchSpy = stubFetch({
      body: JSON.stringify({
        config: {
          perDispatchUsd: 0.5,
          perSessionUsd: 5,
          perDayUsd: 20,
          tier: "free",
        },
        usage: { daySpentUsd: 2.0, dayStart: Date.now() },
      }),
    });
    render(<CostCapTile />);
    await waitFor(() => {
      expect(screen.getByLabelText("Daily spend vs cap")).toBeInTheDocument();
    });
    const tile = screen.getByLabelText("Daily spend vs cap");
    // Slate when spend/cap < 0.5 → "$2.00 / $20.00".
    expect(tile).toHaveAttribute("data-cap-state", "slate");
    expect(tile.textContent).toContain("$2.00");
    expect(tile.textContent).toContain("$20.00");
  });

  it("renders amber when 50-90% of cap", async () => {
    fetchSpy = stubFetch({
      body: JSON.stringify({
        config: {
          perDispatchUsd: 0.5,
          perSessionUsd: 5,
          perDayUsd: 20,
          tier: "free",
        },
        usage: { daySpentUsd: 15.0, dayStart: Date.now() }, // 75%
      }),
    });
    render(<CostCapTile />);
    await waitFor(() => {
      expect(screen.getByLabelText("Daily spend vs cap")).toHaveAttribute(
        "data-cap-state",
        "amber",
      );
    });
  });

  it("renders red + pulse when 90-100% of cap", async () => {
    fetchSpy = stubFetch({
      body: JSON.stringify({
        config: {
          perDispatchUsd: 0.5,
          perSessionUsd: 5,
          perDayUsd: 20,
          tier: "free",
        },
        usage: { daySpentUsd: 19.5, dayStart: Date.now() }, // 97.5%
      }),
    });
    render(<CostCapTile />);
    await waitFor(() => {
      expect(screen.getByLabelText("Daily spend vs cap")).toHaveAttribute(
        "data-cap-state",
        "red",
      );
    });
  });

  it("renders nothing visible when /cost-cap returns 404 (free tier w/ no cap)", async () => {
    fetchSpy = stubFetch("404");
    const { container } = render(<CostCapTile />);
    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalled();
    });
    // After fetch resolves with 404, the tile collapses to an empty
    // wrapper — no spend / cap text visible.
    await new Promise((r) => setTimeout(r, 10));
    expect(container.textContent).not.toContain("$");
  });

  it("renders a tooltip with reset time computed from dayStart", async () => {
    const now = Date.now();
    fetchSpy = stubFetch({
      body: JSON.stringify({
        config: {
          perDispatchUsd: 0.5,
          perSessionUsd: 5,
          perDayUsd: 20,
          tier: "free",
        },
        usage: { daySpentUsd: 1.0, dayStart: now },
      }),
    });
    render(<CostCapTile />);
    await waitFor(() => {
      expect(screen.getByLabelText("Daily spend vs cap")).toBeInTheDocument();
    });
    const tile = screen.getByLabelText("Daily spend vs cap");
    expect(tile.getAttribute("title")).toMatch(/Resets/);
    expect(tile.getAttribute("title")).toMatch(/00:00 UTC/);
  });
});
