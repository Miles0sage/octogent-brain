import type { Database } from "bun:sqlite";

export function ensureOracleSchema(db: Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS corpus_vec USING vec0(embedding float[768]);
    CREATE TABLE IF NOT EXISTS corpus_meta (
      rowid INTEGER PRIMARY KEY,
      cluster_id TEXT UNIQUE,
      description TEXT NOT NULL,
      n_observations INTEGER NOT NULL DEFAULT 1
    );
  `);
}
