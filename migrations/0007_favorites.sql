CREATE TABLE IF NOT EXISTS favorites (
  scope TEXT NOT NULL,
  profile TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(scope, profile, item_id)
);
