PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS school_users (
  id TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('teacher','student')),
  avatar_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS school_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES school_users(id),
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS school_sessions_expiry ON school_sessions(expires_at);
CREATE TABLE IF NOT EXISTS school_auth_challenges (
  token_hash TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS school_auth_challenges_expiry ON school_auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS school_auth_limits (
  bucket TEXT PRIMARY KEY,
  window_at INTEGER NOT NULL,
  counter INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS school_auth_limits_expiry ON school_auth_limits(expires_at);
CREATE TABLE IF NOT EXISTS school_worlds (
  id TEXT PRIMARY KEY,
  teacher_id TEXT NOT NULL REFERENCES school_users(id),
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS school_members (
  world_id TEXT NOT NULL REFERENCES school_worlds(id),
  user_id TEXT NOT NULL REFERENCES school_users(id),
  pose_json TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY(world_id,user_id)
);
CREATE TABLE IF NOT EXISTS school_assets (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES school_worlds(id),
  owner_id TEXT NOT NULL REFERENCES school_users(id),
  object_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  up_axis TEXT NOT NULL CHECK(up_axis IN ('y','z')),
  units TEXT NOT NULL CHECK(units IN ('mm','m','fit10')),
  bytes INTEGER NOT NULL CHECK(bytes > 0),
  triangles INTEGER NOT NULL CHECK(triangles > 0),
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ready')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS school_assets_owner ON school_assets(world_id,owner_id);
CREATE TABLE IF NOT EXISTS school_snapshots (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES school_worlds(id),
  teacher_id TEXT NOT NULL REFERENCES school_users(id),
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS school_snapshots_world ON school_snapshots(world_id,created_at DESC);
