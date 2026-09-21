CREATE TABLE accounts (
  scope TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  origin TEXT NOT NULL,
  sync_after INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX state_expiry ON state(expires);
CREATE TABLE history (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY(scope, key)
);
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  service TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload TEXT NOT NULL,
  created INTEGER NOT NULL,
  due INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX deliveries_due ON deliveries(status, due);
CREATE INDEX deliveries_order ON deliveries(scope, service, created);
CREATE TABLE credentials (
  scope TEXT NOT NULL,
  service TEXT NOT NULL,
  value TEXT NOT NULL,
  lease TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, service)
);
