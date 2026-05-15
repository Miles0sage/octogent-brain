CREATE TABLE IF NOT EXISTS arguments (
  id TEXT PRIMARY KEY,
  pr_url TEXT NOT NULL,
  pr_sha TEXT NOT NULL,
  diff_truncated TEXT NOT NULL,
  pr_title TEXT,
  pr_description TEXT,
  ci_status TEXT,
  darwin_priors_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued','running','done','error')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS verdicts (
  argument_id TEXT NOT NULL REFERENCES arguments(id) ON DELETE CASCADE,
  cli TEXT NOT NULL CHECK (cli IN ('aider','claude-code','codex','gemini-cli')),
  decision TEXT NOT NULL CHECK (decision IN ('APPROVE','REJECT','GATE_FAILED')),
  issues_json TEXT NOT NULL,
  reasoning TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  gate_pass INTEGER NOT NULL CHECK (gate_pass IN (0, 1)),
  PRIMARY KEY (argument_id, cli)
);

CREATE TABLE IF NOT EXISTS votes (
  argument_id TEXT NOT NULL REFERENCES arguments(id) ON DELETE CASCADE,
  voter_hash TEXT NOT NULL,
  voted_cli TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (argument_id, voter_hash)
);

CREATE INDEX IF NOT EXISTS idx_arguments_pr_sha ON arguments(pr_sha);
CREATE INDEX IF NOT EXISTS idx_arguments_status_created ON arguments(status, created_at);
