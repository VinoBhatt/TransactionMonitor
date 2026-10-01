CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','compliance','chief_compliance')),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK(must_change_password IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  password_changed_at TEXT
);
-- Shared-password sessions have no user identity and must be revoked.
DELETE FROM sessions;
ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE sessions ADD COLUMN credential_version TEXT;
CREATE INDEX sessions_user ON sessions(user_id);
ALTER TABLE imports ADD COLUMN user_id TEXT REFERENCES users(id);
ALTER TABLE audit_log ADD COLUMN user_id TEXT REFERENCES users(id);
