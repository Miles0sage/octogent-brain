import type { Db } from "../db";
import * as z from "zod";
import { customAlphabet } from "nanoid";

const nano = customAlphabet("0123456789abcdefghjkmnpqrstvwxyz", 12);
const BodySchema = z.object({ url: z.string().url() });

export interface ArgueOpts {
  onQueued?: (id: string) => void;
  skipFetch?: boolean;
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
