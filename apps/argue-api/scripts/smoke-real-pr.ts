import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { serve } from "bun";
import { openDb, migrate } from "../src/db";
import { createPipelineScheduler } from "../src/pipeline";
import { createAppFetchHandler } from "../src/app";

const DEFAULT_PR_URL = "https://github.com/openai/openai-node/pull/1837";
const POLL_MS = Number(process.env.ARGUED_SMOKE_POLL_MS ?? "2000");
const TIMEOUT_MS = Number(process.env.ARGUED_SMOKE_TIMEOUT_MS ?? "300000");
const KEEP_ARTIFACTS = process.env.ARGUED_SMOKE_KEEP_ARTIFACTS === "1";

const SEEDED_PRIORS = [
  {
    cluster_id: "headers_hidden_in_json",
    description: "Serialization bug where Headers objects vanish from JSON output and rate-limit metadata is lost.",
    n_observations: 7,
    distance: 0.031,
  },
  {
    cluster_id: "error_shape_regression",
    description: "Base error serializer changes public JSON shape and can drop subclass-specific fields or metadata.",
    n_observations: 4,
    distance: 0.044,
  },
  {
    cluster_id: "diagnostic_logging_tradeoff",
    description: "Observability fix helps logs but may expose sensitive or multi-value headers unless redacted deliberately.",
    n_observations: 3,
    distance: 0.052,
  },
] as const;

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const prUrl = process.env.ARGUED_SMOKE_PR_URL ?? DEFAULT_PR_URL;
  const tempDir = await mkdtemp(join(tmpdir(), "argued-smoke-"));
  const dbPath = join(tempDir, "argued.sqlite");
  const previousDbPath = process.env.ARGUED_DB_PATH;
  process.env.ARGUED_DB_PATH = dbPath;

  const db = openDb();
  migrate(db);
  const scheduler = createPipelineScheduler(db, {
    lookupPriors: async () => [...SEEDED_PRIORS],
  });

  const server = serve({
    port: 0,
    fetch: createAppFetchHandler(db, { onQueued: (id) => scheduler.schedule(id) }),
  });

  try {
    const postRes = await fetch(`http://127.0.0.1:${server.port}/argue`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: prUrl }),
    });
    if (!postRes.ok) {
      throw new Error(`POST /argue failed with ${postRes.status}`);
    }

    const queued = await postRes.json() as { id: string; status: string };
    const startedAt = Date.now();

    while (true) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/arguments/${queued.id}`);
      if (!res.ok) {
        throw new Error(`GET /api/arguments/${queued.id} failed with ${res.status}`);
      }
      const result = await res.json() as {
        id: string;
        status: string;
        summary: Record<string, unknown>;
        verdicts: Array<Record<string, unknown>>;
        darwinPriors: unknown[];
        prSha: string;
      };

      if (result.status === "done" || result.status === "error") {
        console.log(JSON.stringify({
          prUrl,
          dbPath: KEEP_ARTIFACTS ? dbPath : null,
          artifactsKept: KEEP_ARTIFACTS,
          wallMs: Date.now() - startedAt,
          result: {
            id: result.id,
            status: result.status,
            prSha: result.prSha,
            darwinPriors: result.darwinPriors.length,
            summary: result.summary,
            verdicts: result.verdicts.map((verdict) => ({
              cli: verdict["cli"],
              decision: verdict["decision"],
              gatePass: verdict["gatePass"],
              reasoning: verdict["reasoning"],
              issues: Array.isArray(verdict["issues"]) ? (verdict["issues"] as unknown[]).slice(0, 2) : [],
            })),
          },
        }, null, 2));
        return;
      }

      if (Date.now() - startedAt > TIMEOUT_MS) {
        throw new Error(`smoke timed out after ${TIMEOUT_MS}ms`);
      }

      await sleep(POLL_MS);
    }
  } finally {
    await scheduler.waitForIdle().catch(() => {});
    server.stop(true);
    db.close(false);
    if (previousDbPath == null) delete process.env.ARGUED_DB_PATH;
    else process.env.ARGUED_DB_PATH = previousDbPath;
    if (!KEEP_ARTIFACTS) {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
