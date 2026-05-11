import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DriversPanel } from "../src/components/DriversPanel";

const LIST_RESPONSE = {
  config_source: "default",
  defaultProvider: "claude-code",
  drivers: [
    {
      provider: "aider",
      transport: "stdio",
      capabilities: ["writer"],
      command: "aider",
      requiredEnv: ["OPENAI_API_KEY"],
      maxCostUsd: 1,
      health: { healthy: false, reason: "env-missing", missing: ["OPENAI_API_KEY"] },
    },
    {
      provider: "claude-code",
      transport: "acp",
      capabilities: ["writer", "evaluator", "all"],
      command: "claude",
      requiredEnv: ["ANTHROPIC_API_KEY"],
      maxCostUsd: 2,
      health: { healthy: false, reason: "transport-unsupported", transport: "acp" },
    },
    {
      provider: "codex",
      transport: "pty",
      capabilities: ["writer", "evaluator"],
      command: "codex",
      requiredEnv: ["OPENAI_API_KEY"],
      maxCostUsd: 1.5,
      health: { healthy: false, reason: "transport-unsupported", transport: "pty" },
    },
    {
      provider: "gemini-cli",
      transport: "stdio",
      capabilities: ["intel"],
      command: "gemini",
      requiredEnv: ["GOOGLE_API_KEY"],
      maxCostUsd: 0.5,
      health: { healthy: true },
    },
  ],
  rules: [
    {
      taskType: "refactor",
      preferred: "aider",
      fallback: ["claude-code"],
      extraArgs: ["--architect"],
    },
    {
      taskType: "verify",
      preferred: "claude-code",
      fallback: ["codex"],
      extraArgs: ["--permission-mode", "plan"],
    },
  ],
};

const DISPATCH_RESPONSE = {
  dispatch_id: "test-dispatch-001",
  taskType: "refactor",
  invocation: {
    provider: "aider",
    command: "aider",
    args: ["--no-pretty", "--yes", "--architect", "rename foo to bar"],
    cwd: "/root/briefingdeck",
    envFlags: ["OPENAI_API_KEY"],
  },
  health: { healthy: false, reason: "env-missing", missing: ["OPENAI_API_KEY"] },
  started_at_iso: "2026-05-11T20:00:00.000Z",
  events: [],
  exit_code: null,
  duration_ms: null,
};

describe("DriversPanel", () => {
  beforeEach(() => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === "/api/claude-brain/drivers" && (!init || init.method !== "POST")) {
        return new Response(JSON.stringify(LIST_RESPONSE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (href === "/api/claude-brain/drivers/dispatch" && init?.method === "POST") {
        return new Response(JSON.stringify(DISPATCH_RESPONSE), {
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

  it("loads drivers list + renders all four providers in the table", async () => {
    const { container } = render(<DriversPanel />);
    await waitFor(() => {
      expect(screen.getByText("Cross-CLI drivers")).toBeInTheDocument();
    });
    const codeTags = container.querySelectorAll("code");
    const codeTexts = Array.from(codeTags).map((c) => c.textContent ?? "");
    expect(codeTexts).toContain("aider");
    expect(codeTexts).toContain("claude-code");
    expect(codeTexts).toContain("codex");
    expect(codeTexts).toContain("gemini-cli");
  });

  it("renders stat tiles with healthy count + default provider", async () => {
    render(<DriversPanel />);
    await waitFor(() => {
      expect(screen.getByText("Drivers")).toBeInTheDocument();
    });
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getAllByText("4").length).toBeGreaterThan(0);
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
  });

  it("renders routing rules with task-type → preferred mapping", async () => {
    render(<DriversPanel />);
    await waitFor(() => {
      expect(screen.getByText("Routing rules")).toBeInTheDocument();
    });
    expect(screen.getAllByText("refactor").length).toBeGreaterThan(0);
    expect(screen.getAllByText("verify").length).toBeGreaterThan(0);
  });

  it("dispatches a refactor task on click + renders the planned invocation", async () => {
    const { container } = render(<DriversPanel />);
    await waitFor(() => {
      expect(screen.getByText("Cross-CLI drivers")).toBeInTheDocument();
    });
    const dispatchButton = screen.getByRole("button", { name: /^Dispatch$/ });
    fireEvent.click(dispatchButton);
    await waitFor(() => {
      expect(screen.getByText("Last dispatch")).toBeInTheDocument();
    });
    const preTag = container.querySelector("pre");
    expect(preTag?.textContent ?? "").toContain("aider");
    expect(preTag?.textContent ?? "").toContain("--architect");
    expect(preTag?.textContent ?? "").toContain("rename foo to bar");
  });

  it("surfaces fetch errors in the alert region", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<DriversPanel />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/HTTP 500/);
  });
});
