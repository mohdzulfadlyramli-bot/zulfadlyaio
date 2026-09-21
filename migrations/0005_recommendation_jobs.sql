CREATE TABLE recommendation_jobs (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  config TEXT NOT NULL,
  origin TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  position INTEGER NOT NULL DEFAULT 0,
  counts TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX recommendation_one_active ON recommendation_jobs(scope) WHERE status='pending';
CREATE INDEX recommendation_scope_created ON recommendation_jobs(scope,created);
