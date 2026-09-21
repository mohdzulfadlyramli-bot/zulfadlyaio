CREATE TABLE bulk_actions (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  profile_id TEXT,
  events TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX bulk_pending ON bulk_actions(scope,status,created);
