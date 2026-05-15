import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureOracleSchema, filterCorpus, embed } from "../src/index";
import type { CorpusEntry } from "../src/filter";

const DB_PATH = process.env.ORACLE_DB_PATH ?? "/root/octogent-brain/apps/argue-api/db/argued.sqlite";
const CORPUS_DIR = process.env.LORE_CORPUS_DIR ?? "/root/claude-brain/dpo-pairs";

async function main() {
  const db = new Database(DB_PATH);
  sqliteVec.load(db);
  ensureOracleSchema(db);

  // Read all daily jsonl files (skip .skipped + .public-corpus variants)
  const files = readdirSync(CORPUS_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  console.log(`Reading ${files.length} corpus files from ${CORPUS_DIR}`);

  const raw: CorpusEntry[] = [];
  for (const f of files) {
    const lines = readFileSync(join(CORPUS_DIR, f), "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.cluster_id && j.rejected?.error) {
          // Take the first non-empty line of the error as the description
          const errorText = String(j.rejected.error);
          const firstLine = errorText.split("\n").find((l: string) => l.trim().length > 0) ?? errorText;
          raw.push({
            cluster_id: j.cluster_id,
            description: firstLine.slice(0, 500),  // cap to 500 chars
            error_class: j.error_class ?? "unknown",
            n_observations: 1,
          });
        }
      } catch {}
    }
  }
  console.log(`Loaded ${raw.length} raw entries`);

  const filtered = filterCorpus(raw);
  console.log(`After filter: ${filtered.length} entries`);

  // Dedupe by cluster_id (keep first occurrence, count repeats)
  const byId = new Map<string, CorpusEntry & { n_observations: number }>();
  for (const e of filtered) {
    const prev = byId.get(e.cluster_id);
    if (prev) prev.n_observations++;
    else byId.set(e.cluster_id, { ...e, n_observations: 1 });
  }

  const entries = [...byId.values()];
  console.log(`Unique clusters to ingest: ${entries.length}`);

  const checkExists = db.query("SELECT rowid FROM corpus_meta WHERE cluster_id = ?");
  const insertMeta = db.query("INSERT INTO corpus_meta (cluster_id, description, n_observations) VALUES (?, ?, ?) RETURNING rowid");
  const insertVec = db.query("INSERT INTO corpus_vec(rowid, embedding) VALUES (?, ?)");

  let inserted = 0;
  let skipped = 0;
  let failed = 0;
  for (const e of entries) {
    if (checkExists.get(e.cluster_id)) { skipped++; continue; }
    try {
      const vec = await embed(e.description, "document");
      const row = insertMeta.get(e.cluster_id, e.description, e.n_observations) as { rowid: number };
      const buf = new Float32Array(vec).buffer;
      insertVec.run(row.rowid, new Uint8Array(buf));
      inserted++;
      await new Promise(r => setTimeout(r, 100));
      if (inserted % 10 === 0) console.log(`  inserted ${inserted}/${entries.length - skipped}`);
    } catch (err) {
      failed++;
      console.error(`  fail ${e.cluster_id}: ${(err as Error).message}`);
      if (failed > 5) {
        console.error("Too many failures, aborting ingest");
        break;
      }
    }
  }

  console.log(`Done. inserted=${inserted} skipped=${skipped} failed=${failed}`);
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
