/**
 * Cloudflare Turnstile verification for /argue POST.
 *
 * Wired so the server NEVER crashes if env vars are unset:
 *   - If TURNSTILE_SECRET_KEY is missing/empty -> verification is skipped
 *     (graceful degrade, returns ok=true with reason="unconfigured", logs warn).
 *   - If secret is set, verifies token via CF siteverify endpoint.
 *
 * Frontend reads TURNSTILE_SITE_KEY (public) for the widget; server reads
 * TURNSTILE_SECRET_KEY for siteverify. Both placeholder-safe.
 *
 * Reference: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TurnstileReason =
  | "unconfigured"
  | "verified"
  | "missing-token"
  | "cf-rejected"
  | "cf-error";

export interface TurnstileResult {
  ok: boolean;
  reason: TurnstileReason;
  errorCodes?: readonly string[];
}

interface CfSiteverifyResponse {
  success: boolean;
  "error-codes"?: readonly string[];
}

let warnedUnconfigured = false;

export function isTurnstileConfigured(): boolean {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  return typeof secret === "string" && secret.length > 0;
}

/**
 * Verify a Turnstile token. Designed to never throw — callers can trust the
 * returned TurnstileResult and decide policy (block, log, allow) themselves.
 *
 * @param req inbound request — used to extract client IP from x-forwarded-for
 * @param token cf-turnstile-response token from the client widget (or null)
 */
export async function verifyTurnstile(
  req: Request,
  token: string | null,
): Promise<TurnstileResult> {
  if (!isTurnstileConfigured()) {
    if (!warnedUnconfigured) {
      // Log once per process so we don't spam logs in dev.
      // biome-ignore lint/suspicious/noConsole: intentional one-shot startup warn
      console.warn(
        "[turnstile] TURNSTILE_SECRET_KEY not set — verification skipped (graceful degrade). " +
          "Set TURNSTILE_SECRET_KEY + TURNSTILE_SITE_KEY in .env to enable rate-limit protection.",
      );
      warnedUnconfigured = true;
    }
    return { ok: true, reason: "unconfigured" };
  }

  if (!token || token.length === 0) {
    return { ok: false, reason: "missing-token" };
  }

  const secret = process.env.TURNSTILE_SECRET_KEY as string;
  const remoteip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

  const form = new URLSearchParams();
  form.set("secret", secret);
  form.set("response", token);
  if (remoteip) form.set("remoteip", remoteip);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
  } catch (err: unknown) {
    return { ok: false, reason: "cf-error" };
  }

  if (!res.ok) {
    return { ok: false, reason: "cf-error" };
  }

  let body: CfSiteverifyResponse;
  try {
    body = (await res.json()) as CfSiteverifyResponse;
  } catch (err: unknown) {
    return { ok: false, reason: "cf-error" };
  }

  if (body.success) {
    return { ok: true, reason: "verified" };
  }
  return { ok: false, reason: "cf-rejected", errorCodes: body["error-codes"] };
}
