import type { Db } from "../db";
import * as z from "zod";
import { customAlphabet } from "nanoid";
import { verifyTurnstile, isTurnstileConfigured } from "../turnstile";

const nano = customAlphabet("0123456789abcdefghjkmnpqrstvwxyz", 12);
const BodySchema = z.object({
  url: z.string().url(),
  // Optional in body — usually sent in header (cf-turnstile-response).
  // Body fallback for clients that can't easily set custom headers.
  turnstileToken: z.string().optional(),
});

export interface ArgueOpts {
  onQueued?: (id: string) => void;
  skipFetch?: boolean;
  /** Skip Turnstile verification entirely (test-only escape hatch). */
  skipTurnstile?: boolean;
}

export async function handleArguePost(
  req: Request,
  db: Db,
  opts: ArgueOpts = {}
): Promise<Response> {
  const parsed = BodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: "invalid body" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  const { url } = parsed.data;

  // Turnstile gate. Graceful-degrade when env vars unset (verifyTurnstile
  // returns ok=true with reason="unconfigured"), so dev + tests work
  // without CF keys. When TURNSTILE_SECRET_KEY is set, every POST must
  // carry a valid cf-turnstile-response header (or body.turnstileToken).
  if (!opts.skipTurnstile && isTurnstileConfigured()) {
    const headerToken = req.headers.get("cf-turnstile-response");
    const token = headerToken ?? parsed.data.turnstileToken ?? null;
    const verdict = await verifyTurnstile(req, token);
    if (!verdict.ok) {
      return new Response(
        JSON.stringify({ error: "turnstile-failed", reason: verdict.reason }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
  }

  if (!url.startsWith("https://github.com/")) {
    return new Response(JSON.stringify({ error: "github.com URLs only" }), { status: 400, headers: { "content-type": "application/json" } });
  }
  if (!/\/pull\/\d+/.test(url)) {
    return new Response(JSON.stringify({ error: "not a pull request URL" }), { status: 400, headers: { "content-type": "application/json" } });
  }

  const existing = db.query(
    `SELECT id, status
     FROM arguments
     WHERE pr_url = ?
       AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`
  ).get(url) as { id: string; status: string } | null;
  if (existing) {
    try {
      opts.onQueued?.(existing.id);
    } catch {}
    return new Response(JSON.stringify({ id: existing.id, status: existing.status, deduped: true }), {
      status: 202,
      headers: { "content-type": "application/json" }
    });
  }

  const id = nano();
  db.query(`
    INSERT INTO arguments (id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', unixepoch())
  `).run(id, url, "", "", null, "", "none");
  try {
    opts.onQueued?.(id);
  } catch {}
  return new Response(JSON.stringify({ id, status: "queued" }), {
    status: 202,
    headers: { "content-type": "application/json" }
  });
}
