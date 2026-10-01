CREATE TABLE datasets (
  name TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE records (
  dataset TEXT NOT NULL,
  version TEXT NOT NULL,
  position INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(dataset, version, position)
);
CREATE TABLE imports (
  id TEXT PRIMARY KEY,
  dataset TEXT NOT NULL,
  expected_version TEXT NOT NULL,
  source TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dataset TEXT NOT NULL,
  version TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE login_attempts (
  address TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
