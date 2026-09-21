CREATE TABLE IF NOT EXISTS item_ratings (
  scope TEXT NOT NULL,
  profile TEXT NOT NULL,
  item_id TEXT NOT NULL,
  likes INTEGER NOT NULL CHECK(likes IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(scope, profile, item_id)
);
