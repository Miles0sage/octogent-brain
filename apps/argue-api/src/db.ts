import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Db = Database;

export function openDb(): Db {
  const path = process.env.ARGUED_DB_PATH ?? "./db/argued.sqlite";
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

export function migrate(db: Db): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    db.exec(readFileSync(join(dir, f), "utf8"));
  }
}
