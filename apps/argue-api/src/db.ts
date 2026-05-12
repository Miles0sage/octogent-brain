import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function openDb(): Database.Database {
  const path = process.env.ARGUED_DB_PATH ?? "./db/argued.sqlite";
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function migrate(db: Database.Database): void {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
}
