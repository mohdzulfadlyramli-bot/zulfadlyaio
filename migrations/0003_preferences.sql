CREATE TABLE preferences (
  scope TEXT NOT NULL,
  profile TEXT NOT NULL,
  id TEXT NOT NULL,
  client TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(scope, profile, id, client)
);
ALTER TABLE accounts ADD COLUMN processed_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX accounts_work_order ON accounts(processed_at);
