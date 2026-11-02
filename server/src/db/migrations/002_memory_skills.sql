-- Phase 2a: memory (vault index + proposals) and skills.
CREATE TABLE notes_index (
  path TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT,
  status TEXT,
  tags TEXT,
  updated TEXT,
  project TEXT,
  tokens INTEGER NOT NULL DEFAULT 0,
  mtime REAL NOT NULL DEFAULT 0,
  frontmatter_json TEXT
);
CREATE INDEX notes_index_type ON notes_index(type);

-- Plain fallback table; the FTS5 virtual table notes_fts is created at runtime when available.
CREATE TABLE notes_body (
  path TEXT PRIMARY KEY,
  body TEXT NOT NULL
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'vault',
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  synced_at TEXT,
  hash TEXT
);

CREATE TABLE skill_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  existing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE memory_proposals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  target_path TEXT NOT NULL,
  diff TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','applied','failed')),
  created_at TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'append',
  content TEXT NOT NULL DEFAULT '',
  base_hash TEXT,
  decided_at TEXT,
  error TEXT
);
CREATE INDEX memory_proposals_status ON memory_proposals(status, created_at);
