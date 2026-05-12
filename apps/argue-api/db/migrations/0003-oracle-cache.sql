CREATE TABLE IF NOT EXISTS oracle_cache (
  diff_hash TEXT PRIMARY KEY,
  priors_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arguments_pr_url_status_created
ON arguments(pr_url, status, created_at DESC);
