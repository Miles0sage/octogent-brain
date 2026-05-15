import { describe, expect, it } from "vitest";
import { parseDispatchMode, pickClisForMode } from "../src/dispatch-mode";
import type { Prior } from "../src/argue";

describe("parseDispatchMode", () => {
  it("defaults to competitive when env var unset", () => {
    expect(parseDispatchMode(undefined)).toBe("competitive");
    expect(parseDispatchMode("")).toBe("competitive");
  });

  it("accepts focused / quick / competitive case-insensitively", () => {
    expect(parseDispatchMode("focused")).toBe("focused");
    expect(parseDispatchMode("QUICK")).toBe("quick");
    expect(parseDispatchMode(" Competitive ")).toBe("competitive");
  });

  it("falls back to competitive on unknown values rather than throwing", () => {
    expect(parseDispatchMode("garbage")).toBe("competitive");
  });
});

describe("pickClisForMode", () => {
  const prior = (cluster: string, description: string): Prior => ({
    cluster_id: cluster,
    description,
    n_observations: 5,
  });

  it("returns all 4 CLIs in competitive mode", () => {
    expect(pickClisForMode("competitive", [])).toEqual([
      "aider",
      "claude-code",
      "codex",
      "gemini-cli",
    ]);
  });

  it("returns claude-code only in quick mode", () => {
    expect(pickClisForMode("quick", [])).toEqual(["claude-code"]);
    // even with strong priors, quick mode ignores them
    expect(
      pickClisForMode("quick", [prior("inj_sql", "SQL injection in user input")])
    ).toEqual(["claude-code"]);
  });

  it("focused mode picks codex on security-class top prior", () => {
    const out = pickClisForMode("focused", [
      prior("inj_sql", "SQL injection in user input"),
    ]);
    expect(out).toEqual(["claude-code", "codex"]);
  });

  it("focused mode picks gemini-cli on UI-class top prior", () => {
    const out = pickClisForMode("focused", [
      prior("a11y_focus", "Accessibility focus-visible regression"),
    ]);
    expect(out).toEqual(["claude-code", "gemini-cli"]);
  });

  it("focused mode picks aider on refactor-class top prior", () => {
    const out = pickClisForMode("focused", [
      prior("ref_rename", "Rename touches only some call sites"),
    ]);
    expect(out).toEqual(["claude-code", "aider"]);
  });

  it("focused mode defaults to codex when priors are empty", () => {
    expect(pickClisForMode("focused", [])).toEqual(["claude-code", "codex"]);
  });
});
