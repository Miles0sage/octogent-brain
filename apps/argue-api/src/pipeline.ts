import { createHash } from "node:crypto";
import { fetchPR as defaultFetchPR, type PRPayload } from "../../../packages/pr-fetcher/src/index.js";
import { createOracle, type Prior as OraclePrior } from "../../../packages/oracle/src/index.js";
import { argue, type ArgueInput, type CliName, type RawVerdict } from "../../../packages/supervisor/src/argue.js";
import { dispatchAll } from "../../../packages/supervisor/src/dispatchers/index.js";
import { validateVerdict } from "../../../packages/core/src/verdict-gate.js";
import type { Db } from "./db";

interface ArgumentRow {
  id: string;
  pr_url: string;
  pr_sha: string;
  diff_truncated: string;
  pr_title: string | null;
  pr_description: string | null;
  ci_status: string | null;
}

interface OracleCacheRow {
  priors_json: string;
}

export interface PipelineDeps {
  dispatch?: (cli: CliName, input: ArgueInput) => Promise<RawVerdict>;
  fetchPR?: (url: string) => Promise<PRPayload>;
  logger?: Pick<Console, "error" | "warn">;
  lookupPriors?: (input: {
    db: Db;
    diff: string;
    diffHash: string;
    prSha: string;
    prUrl: string;
  }) => Promise<OraclePrior[]>;
  now?: () => number;
}

export interface PipelineScheduler {
  inFlightCount(): number;
  resumePending(): void;
  schedule(id: string): void;
  waitForIdle(): Promise<void>;
}

type StoredVerdictDecision =
  | "APPROVE"
  | "REJECT"
  | "GATE_FAILED"
  | "PARSE_FAILED"
  | "TRANSPORT_FAILED";

interface StoredVerdict {
  cli: CliName;
  cost_usd: number;
  decision: StoredVerdictDecision;
  duration_ms: number;
  gate_pass: 0 | 1;
  issues_json: string;
  reasoning: string;
}

const selectArgumentRow = (db: Db, id: string): ArgumentRow | null =>
  (db
    .query(
      `SELECT id, pr_url, pr_sha, diff_truncated, pr_title, pr_description, ci_status
       FROM arguments
       WHERE id = ?`
    )
    .get(id) as ArgumentRow | null) ?? null;

const buildDefaultLookupPriors = (db: Db, deps: PipelineDeps) => {
  const oracle = createOracle(db);
  const logger = deps.logger ?? console;

  return async ({
    diff,
  }: {
    db: Db;
    diff: string;
    diffHash: string;
    prSha: string;
    prUrl: string;
  }): Promise<OraclePrior[]> => {
    try {
      return await oracle.lookup(diff);
    } catch (error) {
      logger.warn?.(`[argued] oracle lookup unavailable: ${serializeError(error)}`);
      return [];
    }
  };
};

const needsFetch = (row: ArgumentRow): boolean =>
  row.pr_sha.trim().length === 0 || row.diff_truncated.trim().length === 0 || !row.pr_title;

const persistFetchedPayload = (db: Db, id: string, payload: PRPayload) => {
  db.query(
    `UPDATE arguments
     SET pr_sha = ?,
         diff_truncated = ?,
         pr_title = ?,
         pr_description = ?,
         ci_status = ?
     WHERE id = ?`
  ).run(
    payload.sha,
    payload.diff,
    payload.title,
    payload.description,
    payload.ciStatus,
    id
  );
};

const persistVerdict = (db: Db, id: string, row: StoredVerdict) => {
  db.query(
    `INSERT INTO verdicts (
      argument_id,
      cli,
      decision,
      issues_json,
      reasoning,
      cost_usd,
      duration_ms,
      gate_pass
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(argument_id, cli) DO UPDATE SET
      decision = excluded.decision,
      issues_json = excluded.issues_json,
      reasoning = excluded.reasoning,
      cost_usd = excluded.cost_usd,
      duration_ms = excluded.duration_ms,
      gate_pass = excluded.gate_pass`
  ).run(
    id,
    row.cli,
    row.decision,
    row.issues_json,
    row.reasoning,
    row.cost_usd,
    row.duration_ms,
    row.gate_pass
  );
};

const persistVerdicts = (db: Db, id: string, verdicts: StoredVerdict[]) => {
  const tx = db.transaction((rows: StoredVerdict[]) => {
    db.query("DELETE FROM verdicts WHERE argument_id = ?").run(id);
    for (const row of rows) {
      persistVerdict(db, id, row);
    }
  });
  tx(verdicts);
};

const buildStoredVerdict = (verdict: RawVerdict): StoredVerdict => {
  if (verdict.state === "transport_failed") {
    return {
      cli: verdict.cli,
      cost_usd: verdict.cost_usd,
      decision: "TRANSPORT_FAILED",
      duration_ms: verdict.duration_ms,
      gate_pass: 0,
      issues_json: JSON.stringify(verdict.issues),
      reasoning: verdict.reasoning,
    };
  }

  if (verdict.state === "parse_failed" || !verdict.decision) {
    return {
      cli: verdict.cli,
      cost_usd: verdict.cost_usd,
      decision: "PARSE_FAILED",
      duration_ms: verdict.duration_ms,
      gate_pass: 0,
      issues_json: JSON.stringify(verdict.issues),
      reasoning: verdict.reasoning,
    };
  }

  const gate = validateVerdict({
    decision: verdict.decision,
    issues: verdict.issues,
    reasoning: verdict.reasoning,
  });

  return {
    cli: verdict.cli,
    cost_usd: verdict.cost_usd,
    decision: gate.gate_pass ? verdict.decision : "GATE_FAILED",
    duration_ms: verdict.duration_ms,
    gate_pass: gate.gate_pass ? 1 : 0,
    issues_json: JSON.stringify(verdict.issues),
    reasoning: gate.gate_pass
      ? verdict.reasoning
      : `${verdict.reasoning} | gate: ${gate.reason}`,
  };
};

const buildStoredVerdicts = (verdicts: RawVerdict[]): StoredVerdict[] =>
  verdicts.map((verdict) => buildStoredVerdict(verdict));

const serializeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const hashDiff = (diff: string): string =>
  createHash("sha256").update(diff).digest("hex");

const loadCachedPriors = (db: Db, diffHash: string): OraclePrior[] | null => {
  const cached =
    (db
      .query("SELECT priors_json FROM oracle_cache WHERE diff_hash = ?")
      .get(diffHash) as OracleCacheRow | null) ?? null;
  if (!cached) return null;
  return JSON.parse(cached.priors_json) as OraclePrior[];
};

const persistCachedPriors = (
  db: Db,
  diffHash: string,
  priors: OraclePrior[],
  createdAt: number
) => {
  db.query(
    `INSERT INTO oracle_cache (diff_hash, priors_json, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(diff_hash) DO UPDATE SET
       priors_json = excluded.priors_json,
       created_at = excluded.created_at`
  ).run(diffHash, JSON.stringify(priors), createdAt);
};

const ensureArgumentPayload = async (
  db: Db,
  id: string,
  row: ArgumentRow,
  fetchPR: (url: string) => Promise<PRPayload>
): Promise<PRPayload> => {
  if (!needsFetch(row)) {
    return {
      url: row.pr_url,
      sha: row.pr_sha,
      title: row.pr_title ?? "",
      description: row.pr_description ?? "",
      diff: row.diff_truncated,
      ciStatus: (row.ci_status as PRPayload["ciStatus"] | null) ?? "none",
    };
  }

  const payload = await fetchPR(row.pr_url);
  persistFetchedPayload(db, id, payload);
  return payload;
};

export async function runPipeline(
  id: string,
  db: Db,
  deps: PipelineDeps = {}
): Promise<boolean> {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const fetchPR = deps.fetchPR ?? defaultFetchPR;
  const dispatch = deps.dispatch ?? dispatchAll;
  const lookupPriors = deps.lookupPriors ?? buildDefaultLookupPriors(db, deps);

  const claim = db.query(
    `UPDATE arguments
     SET status = 'running',
         completed_at = NULL,
         error_message = NULL
     WHERE id = ?
       AND status = 'queued'`
  ).run(id);
  if (Number(claim.changes ?? 0) === 0) return false;

  try {
    const row = selectArgumentRow(db, id);
    if (!row) throw new Error(`argument ${id} missing after claim`);

    db.query("DELETE FROM verdicts WHERE argument_id = ?").run(id);

    const payload = await ensureArgumentPayload(db, id, row, fetchPR);
    const diffHash = hashDiff(payload.diff);
    const cachedPriors = loadCachedPriors(db, diffHash);
    const priors =
      cachedPriors ??
      (await lookupPriors({
        db,
        diff: payload.diff,
        diffHash,
        prSha: payload.sha,
        prUrl: payload.url,
      }));
    if (!cachedPriors) {
      persistCachedPriors(db, diffHash, priors, now());
    }

    db.query("UPDATE arguments SET darwin_priors_json = ? WHERE id = ?").run(
      JSON.stringify(priors),
      id
    );

    const { verdicts } = await argue(
      {
        diff: payload.diff,
        description: payload.description,
        ciStatus: payload.ciStatus,
        darwin_priors: priors,
      },
      {
        dispatch,
        onVerdict: async (verdict) => {
          persistVerdict(db, id, buildStoredVerdict(verdict));
        },
      }
    );

    persistVerdicts(db, id, buildStoredVerdicts(verdicts));
    db.query(
      `UPDATE arguments
       SET status = 'done',
           completed_at = ?,
           error_message = NULL
       WHERE id = ?`
    ).run(now(), id);
    return true;
  } catch (error) {
    db.query(
      `UPDATE arguments
       SET status = 'error',
           error_message = ?,
           completed_at = ?
       WHERE id = ?`
    ).run(serializeError(error), now(), id);
    return false;
  }
}

export function requeueInterruptedArguments(db: Db): number {
  const result = db
    .query("UPDATE arguments SET status = 'queued' WHERE status = 'running'")
    .run();
  return Number(result.changes ?? 0);
}

export function loadQueuedArgumentIds(db: Db): string[] {
  return (
    db
      .query("SELECT id FROM arguments WHERE status = 'queued' ORDER BY created_at ASC, id ASC")
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

export function createPipelineScheduler(
  db: Db,
  deps: PipelineDeps = {}
): PipelineScheduler {
  const inFlight = new Map<string, Promise<void>>();
  const logger = deps.logger ?? console;

  const launch = (id: string): Promise<void> => {
    const existing = inFlight.get(id);
    if (existing) return existing;

    const job = runPipeline(id, db, deps)
      .catch((error) => {
        logger.error?.(`[argued] pipeline crash for ${id}: ${serializeError(error)}`);
      })
      .finally(() => {
        inFlight.delete(id);
      });

    inFlight.set(id, job);
    return job;
  };

  return {
    inFlightCount: () => inFlight.size,
    resumePending() {
      requeueInterruptedArguments(db);
      for (const id of loadQueuedArgumentIds(db)) {
        void launch(id);
      }
    },
    schedule(id: string) {
      void launch(id);
    },
    waitForIdle() {
      return Promise.all([...inFlight.values()]).then(() => undefined);
    },
  };
}
