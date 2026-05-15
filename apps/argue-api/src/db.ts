import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as sqliteVec from "sqlite-vec";
import { ensureOracleSchema } from "../../../packages/oracle/src/index.js";

export type Db = Database;

const VERDICTS_TABLE_SQL = `CREATE TABLE verdicts (
  argument_id TEXT NOT NULL REFERENCES arguments(id) ON DELETE CASCADE,
  cli TEXT NOT NULL CHECK (cli IN ('aider','claude-code','codex','gemini-cli')),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT','GATE_FAILED','PARSE_FAILED','TRANSPORT_FAILED')),
  issues_json TEXT NOT NULL,
  reasoning TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  gate_pass INTEGER NOT NULL CHECK (gate_pass IN (0, 1)),
  PRIMARY KEY (argument_id, cli)
)`;

export function openDb(): Db {
  const path = process.env.ARGUED_DB_PATH ?? "./db/argued.sqlite";
  const db = new Database(path);
  sqliteVec.load(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  ensureOracleSchema(db);
  return db;
}

function ensureVerdictsTableShape(db: Db): void {
  const row = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verdicts'")
    .get() as { sql: string } | null;
  if (!row?.sql) return;
  if (row.sql.includes("'PARSE_FAILED'") && row.sql.includes("'TRANSPORT_FAILED'")) return;

  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE verdicts RENAME TO verdicts_legacy");
    db.exec(VERDICTS_TABLE_SQL);
    db.exec(
      `INSERT INTO verdicts (
        argument_id,
        cli,
        decision,
        issues_json,
        reasoning,
        cost_usd,
        duration_ms,
        gate_pass
      )
      SELECT
        argument_id,
        cli,
        decision,
        issues_json,
        reasoning,
        cost_usd,
        duration_ms,
        gate_pass
      FROM verdicts_legacy`
    );
    db.exec("DROP TABLE verdicts_legacy");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db: Db): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      db.exec(readFileSync(join(dir, f), "utf8"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("duplicate column name")) throw error;
    }
  }
  ensureVerdictsTableShape(db);
}
