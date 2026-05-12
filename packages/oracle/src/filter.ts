export interface CorpusEntry {
  cluster_id: string;
  description: string;
  error_class: string;
  n_observations?: number;
}

export function filterCorpus(entries: CorpusEntry[]): CorpusEntry[] {
  return entries.filter(
    (e) =>
      e.description &&
      e.description.length >= 30 &&
      e.error_class !== "auth_error"
  );
}
