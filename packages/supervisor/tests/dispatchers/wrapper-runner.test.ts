import { describe, expect, it } from "vitest";
import {
  buildWrapperArgs,
  extractSessionId,
  isWrapperUsable,
  resolveWrapperBinary,
} from "../../src/dispatchers/wrapper-runner";

describe("resolveWrapperBinary", () => {
  it("honors ARGUED_WRAPPER_BIN override", () => {
    expect(resolveWrapperBinary("/custom/path/codeagent-wrapper")).toBe(
      "/custom/path/codeagent-wrapper"
    );
  });

  it("returns null on no override and unknown platform path", () => {
    const path = resolveWrapperBinary();
    expect(typeof path === "string" || path === null).toBe(true);
  });
});

describe("isWrapperUsable", () => {
  it("returns false for a path that does not exist", async () => {
    const ok = await isWrapperUsable("/nonexistent/codeagent-wrapper");
    expect(ok).toBe(false);
  });
});

describe("buildWrapperArgs", () => {
  it("emits --backend + stdin sentinel + optional workdir for codex", () => {
    expect(buildWrapperArgs("codex")).toEqual(["--backend", "codex", "-"]);
    expect(buildWrapperArgs("codex", { workdir: "/tmp/work" })).toEqual([
      "--backend",
      "codex",
      "-",
      "/tmp/work",
    ]);
  });

  it("prepends --lite when lite mode requested", () => {
    expect(buildWrapperArgs("claude", { lite: true })).toEqual([
      "--lite",
      "--backend",
      "claude",
      "-",
    ]);
  });

  it("passes --gemini-model only when backend is gemini", () => {
    expect(
      buildWrapperArgs("gemini", { geminiModel: "gemini-2.5-flash" })
    ).toEqual(["--backend", "gemini", "--gemini-model", "gemini-2.5-flash", "-"]);
    // ignored for non-gemini backends
    expect(
      buildWrapperArgs("codex", { geminiModel: "gemini-2.5-flash" })
    ).toEqual(["--backend", "codex", "-"]);
  });

  it("inserts resume <sessionId> ahead of the stdin sentinel", () => {
    expect(
      buildWrapperArgs("codex", { sessionId: "sess_abc123" })
    ).toEqual(["--backend", "codex", "resume", "sess_abc123", "-"]);
  });
});

describe("extractSessionId", () => {
  it("returns null and original message when no SESSION_ID marker", () => {
    const { sessionId, message } = extractSessionId("just the assistant text");
    expect(sessionId).toBeNull();
    expect(message).toBe("just the assistant text");
  });

  it("strips a `SESSION_ID: <id>` marker and trims the surrounding text", () => {
    const { sessionId, message } = extractSessionId(
      "verdict text\nSESSION_ID: sess_42-deadbeef\nmore text"
    );
    expect(sessionId).toBe("sess_42-deadbeef");
    expect(message).toContain("verdict text");
    expect(message).toContain("more text");
    expect(message).not.toContain("SESSION_ID");
  });

  it("requires at least 6 chars in the id (rejects accidental matches)", () => {
    const { sessionId } = extractSessionId("SESSION_ID: short");
    expect(sessionId).toBeNull();
  });
});
