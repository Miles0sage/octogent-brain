import type { Database } from "bun:sqlite";
import { embed as defaultEmbed } from "./embed.js";
import { ensureOracleSchema } from "./schema.js";

export interface Prior {
  cluster_id: string;
  description: string;
  n_observations: number;
  distance: number;
}

export interface OracleOpts {
  embedFn?: (text: string, purpose: "document" | "query") => Promise<number[]>;
  topK?: number;
}

export function createOracle(db: Database, opts: OracleOpts = {}) {
  const embedFn = opts.embedFn ?? defaultEmbed;
  const topK = opts.topK ?? 3;
  return {
    async lookup(diff: string): Promise<Prior[]> {
      const vec = await embedFn(diff, "query");
      const buf = new Float32Array(vec);
      const rows = db.prepare<
        { cluster_id: string; description: string; n_observations: number; distance: number },
        [Uint8Array]
      >(
        `SELECT m.cluster_id, m.description, m.n_observations, v.distance
         FROM corpus_vec v
         JOIN corpus_meta m ON m.rowid = v.rowid
         WHERE v.embedding MATCH ?
         AND k = ${topK}
         ORDER BY v.distance`
      ).all(buf as unknown as Uint8Array);
      return rows.map((r) => ({
        cluster_id: String(r.cluster_id),
        description: String(r.description),
        n_observations: Number(r.n_observations),
        distance: Number(r.distance),
      }));
    },
  };
}

export { filterCorpus, type CorpusEntry } from "./filter.js";
export { embed } from "./embed.js";
export { l2Normalize } from "./normalize.js";
export { ensureOracleSchema } from "./schema.js";
