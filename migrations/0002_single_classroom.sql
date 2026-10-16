-- Additive: legacy worlds, memberships, assets and snapshots are preserved.
CREATE TABLE school_student_credentials (
  slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 30),
  user_id TEXT NOT NULL UNIQUE REFERENCES school_users(id),
  login_id TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
