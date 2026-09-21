CREATE TABLE IF NOT EXISTS update_history (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  build_id TEXT,
  build_url TEXT,
  branch TEXT,
  finished_at INTEGER,
  checked_at INTEGER
);
CREATE INDEX IF NOT EXISTS update_history_requested ON update_history(requested_at DESC);
