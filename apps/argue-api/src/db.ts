import { createClient, type Client } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export type Db = Client;

export function openDb(): Db {
  const path = process.env.ARGUED_DB_PATH ?? "./db/argued.sqlite";
  const url = path === ":memory:" ? "file::memory:?cache=shared" : `file:${path}`;
  return createClient({ url });
}

export async function migrate(db: Db): Promise<void> {
  await db.execute("PRAGMA journal_mode = WAL");
  await db.execute("PRAGMA foreign_keys = ON");
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", "db", "migrations");
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8");
    await db.executeMultiple(sql);
  }
}
