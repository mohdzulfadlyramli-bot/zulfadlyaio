CREATE TABLE IF NOT EXISTS dropped_shows (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  ids TEXT NOT NULL,
  item_id TEXT,
  dropped INTEGER NOT NULL CHECK(dropped IN (0, 1)),
  updated INTEGER NOT NULL,
  source TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, key)
);
