import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyTurnstile, isTurnstileConfigured } from "../src/turnstile";

const ORIGINAL_ENV = { ...process.env };

describe("Turnstile middleware", () => {
  beforeEach(() => {
    // Reset env between tests
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_SITE_KEY;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  describe("isTurnstileConfigured", () => {
    it("returns false when TURNSTILE_SECRET_KEY is unset", () => {
      expect(isTurnstileConfigured()).toBe(false);
    });

    it("returns false when TURNSTILE_SECRET_KEY is empty string", () => {
      process.env.TURNSTILE_SECRET_KEY = "";
      expect(isTurnstileConfigured()).toBe(false);
    });

    it("returns true when TURNSTILE_SECRET_KEY is set to a non-empty value", () => {
      process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
      expect(isTurnstileConfigured()).toBe(true);
    });
  });

  describe("verifyTurnstile (graceful-degrade when unconfigured)", () => {
    it("returns ok=true with reason='unconfigured' when secret env unset (does NOT crash)", async () => {
      const req = new Request("http://localhost/argue", {
        method: "POST",
        body: JSON.stringify({ url: "https://github.com/x/y/pull/1" }),
        headers: { "content-type": "application/json" },
      });
      const result = await verifyTurnstile(req, null);
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("unconfigured");
    });

    it("returns ok=true with reason='unconfigured' even when token is provided (graceful)", async () => {
      const req = new Request("http://localhost/argue", {
        method: "POST",
        body: JSON.stringify({ url: "https://github.com/x/y/pull/1" }),
        headers: { "content-type": "application/json" },
      });
      const result = await verifyTurnstile(req, "any-token");
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("unconfigured");
    });
  });

  describe("verifyTurnstile (when configured)", () => {
    beforeEach(() => {
      process.env.TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA"; // CF dummy "always pass"
    });

    it("returns ok=false with reason='missing-token' when token is null and secret is set", async () => {
      const req = new Request("http://localhost/argue", { method: "POST" });
      const result = await verifyTurnstile(req, null);
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing-token");
    });

    it("returns ok=false with reason='missing-token' when token is empty string", async () => {
      const req = new Request("http://localhost/argue", { method: "POST" });
      const result = await verifyTurnstile(req, "");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("missing-token");
    });

    it("returns ok=true when CF siteverify confirms token (mocked fetch)", async () => {
      const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      const req = new Request("http://localhost/argue", {
        method: "POST",
        headers: { "x-forwarded-for": "1.2.3.4" },
      });
      const result = await verifyTurnstile(req, "valid-token");
      expect(result.ok).toBe(true);
      expect(result.reason).toBe("verified");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        expect.objectContaining({ method: "POST" })
      );
    });

    it("returns ok=false with reason='cf-rejected' when CF returns success=false", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ success: false, "error-codes": ["invalid-input-response"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
      const req = new Request("http://localhost/argue", { method: "POST" });
      const result = await verifyTurnstile(req, "bad-token");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("cf-rejected");
    });

    it("returns ok=false with reason='cf-error' when CF siteverify network fails (does NOT throw)", async () => {
      vi.spyOn(global, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
      const req = new Request("http://localhost/argue", { method: "POST" });
      const result = await verifyTurnstile(req, "any-token");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("cf-error");
    });

    it("returns ok=false with reason='cf-error' when CF returns non-200", async () => {
      vi.spyOn(global, "fetch").mockResolvedValue(
        new Response("Internal Server Error", { status: 500 })
      );
      const req = new Request("http://localhost/argue", { method: "POST" });
      const result = await verifyTurnstile(req, "any-token");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("cf-error");
    });
  });
});
