// Adapted from VRSEN/agency-swarm (MIT) — covers the agency-chart validator
// equivalent to `parse_agent_flows` checks in `src/agency_swarm/agency/setup.py`.
import { describe, expect, it } from "vitest";

import {
  type AgencyChart,
  validateChart,
} from "../src/domain/agencyChart";

const baseChart = (overrides: Partial<AgencyChart> = {}): AgencyChart => ({
  entryPoints: ["coord"],
  sharedInstructions: "AGENCY.md",
  flows: [
    { from: "coord", to: "bd-research" },
    { from: "coord", to: "bd-builder" },
    { from: "bd-builder", to: "bd-reviewer" },
  ],
  ...overrides,
});

describe("validateChart — happy path", () => {
  it("accepts a well-formed chart with one entrypoint and a tree of flows", () => {
    const result = validateChart(baseChart());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("accepts a multi-entrypoint chart when both entrypoints appear in flows", () => {
    const result = validateChart(
      baseChart({
        entryPoints: ["coord", "bd-builder"],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateChart — missing entrypoint", () => {
  it("rejects an empty entryPoints array", () => {
    const result = validateChart(baseChart({ entryPoints: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "chart.entryPoints must contain at least one role name",
    );
  });

  it("rejects an entryPoint that is not referenced by any flow", () => {
    const result = validateChart(
      baseChart({ entryPoints: ["ghost-coordinator"] }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("ghost-coordinator"))).toBe(
      true,
    );
  });
});

describe("validateChart — dangling references and structural errors", () => {
  it("rejects empty flows", () => {
    const result = validateChart(baseChart({ flows: [] }));
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "chart.flows must contain at least one {from, to} edge",
    );
  });

  it("rejects missing sharedInstructions", () => {
    const result = validateChart(baseChart({ sharedInstructions: "" }));
    expect(result.ok).toBe(false);
    expect(
      result.errors.some((e) => e.includes("sharedInstructions")),
    ).toBe(true);
  });

  it("rejects a self-edge (a -> a)", () => {
    const result = validateChart(
      baseChart({
        flows: [
          { from: "coord", to: "bd-research" },
          { from: "bd-builder", to: "bd-builder" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("self-edge"))).toBe(true);
  });

  it("rejects duplicate edges", () => {
    const result = validateChart(
      baseChart({
        flows: [
          { from: "coord", to: "bd-research" },
          { from: "coord", to: "bd-research" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicate"))).toBe(true);
  });
});

describe("validateChart — cycle detection", () => {
  it("rejects a 2-cycle a -> b -> a", () => {
    const result = validateChart(
      baseChart({
        flows: [
          { from: "coord", to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "a" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("rejects a 3-cycle a -> b -> c -> a", () => {
    const result = validateChart(
      baseChart({
        flows: [
          { from: "coord", to: "a" },
          { from: "a", to: "b" },
          { from: "b", to: "c" },
          { from: "c", to: "a" },
        ],
      }),
    );
    expect(result.ok).toBe(false);
    const cycleErr = result.errors.find((e) => e.startsWith("cycle"));
    expect(cycleErr).toBeDefined();
    expect(cycleErr).toMatch(/a/);
    expect(cycleErr).toMatch(/b/);
    expect(cycleErr).toMatch(/c/);
  });

  it("accepts a DAG with diamond shape (no cycle)", () => {
    const result = validateChart(
      baseChart({
        entryPoints: ["coord"],
        flows: [
          { from: "coord", to: "a" },
          { from: "coord", to: "b" },
          { from: "a", to: "c" },
          { from: "b", to: "c" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});
