import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureRuntimeAuthTokenFromUrl,
  installRuntimeAuthFetch,
  readRuntimeAuthToken,
  resetRuntimeAuthForTests,
} from "../src/runtime/runtimeAuth";

describe("runtimeAuth", () => {
  beforeEach(() => {
    resetRuntimeAuthForTests();
    window.localStorage.clear();
  });

  afterEach(() => {
    resetRuntimeAuthForTests();
    window.localStorage.clear();
  });

  it("captures the runtime auth token from the URL and strips it from browser history", () => {
    const replaceState = vi.fn();
    const token = captureRuntimeAuthTokenFromUrl(
      new URL(
        "https://dashboard.example.com/?octogent_token=secret-token&tab=drivers",
      ) as unknown as Location,
      { replaceState } as History,
    );

    expect(token).toBe("secret-token");
    expect(readRuntimeAuthToken()).toBe("secret-token");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://dashboard.example.com/?tab=drivers",
    );
  });

  it("injects X-Octogent-Token into same-origin fetch requests", async () => {
    window.localStorage.setItem("octogent.apiToken", "secret-token");
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as typeof window.fetch;
    window.fetch = fetchSpy;

    installRuntimeAuthFetch(new URL("https://dashboard.example.com/app") as unknown as Location);

    await window.fetch("/api/terminals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "planner" }),
    });

    const request = fetchSpy.mock.calls[0]?.[0] as Request;
    expect(request).toBeInstanceOf(Request);
    expect(request.headers.get("x-octogent-token")).toBe("secret-token");
  });

  it("does not inject the runtime token for unrelated origins", async () => {
    window.localStorage.setItem("octogent.apiToken", "secret-token");
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ) as typeof window.fetch;
    window.fetch = fetchSpy;

    installRuntimeAuthFetch(new URL("https://dashboard.example.com/app") as unknown as Location);

    await window.fetch("https://example.net/api/terminals");

    const request = fetchSpy.mock.calls[0]?.[0] as RequestInfo | URL;
    if (request instanceof Request) {
      expect(request.headers.get("x-octogent-token")).toBeNull();
    } else {
      expect(request).toBe("https://example.net/api/terminals");
    }
  });
});
