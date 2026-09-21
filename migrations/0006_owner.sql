CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_key TEXT NOT NULL,
  username TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created INTEGER NOT NULL
);
