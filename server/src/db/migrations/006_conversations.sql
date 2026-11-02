-- Conversations: a task in 'chat' mode is a conversation and each message is one run in it.
ALTER TABLE tasks ADD COLUMN mode TEXT NOT NULL DEFAULT 'task';
-- What each run was asked to use, what it was given, and its final answer (for history and search).
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN effort TEXT;
ALTER TABLE runs ADD COLUMN attachments_json TEXT;
ALTER TABLE runs ADD COLUMN answer TEXT;

-- Files the owner attached in the composer. Copied into the run's working folder when used.
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_mode_updated ON tasks (mode, updated_at);
