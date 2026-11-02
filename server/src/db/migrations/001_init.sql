-- Phase 1: core tables.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('code','client','area')),
  path TEXT,
  repo TEXT,
  vault_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('code','research','write','admin','update','memory','other')),
  status TEXT NOT NULL CHECK (status IN ('inbox','queued','running','needs_you','done','failed','cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  agent_pref TEXT NOT NULL DEFAULT 'auto' CHECK (agent_pref IN ('auto','claude','codex')),
  agent TEXT,
  effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('low','medium','high')),
  parent_id TEXT,
  schedule_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  due_at TEXT,
  result_summary TEXT,
  output_path TEXT,
  outward INTEGER NOT NULL DEFAULT 0,
  route_reason TEXT,
  not_before TEXT
);
CREATE INDEX tasks_status ON tasks(status, priority DESC, created_at);
CREATE INDEX tasks_project ON tasks(project_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  session_id TEXT,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed','cancelled')),
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_estimate_usd REAL NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  context_report_json TEXT,
  route_reason TEXT,
  prompt TEXT
);
CREATE INDEX runs_task ON runs(task_id, started_at);
CREATE INDEX runs_started ON runs(started_at);

CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message','tool_call','tool_result','file_change','status','usage','error')),
  payload_json TEXT NOT NULL
);
CREATE INDEX run_events_run ON run_events(run_id, id);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_via TEXT,
  note TEXT
);
CREATE INDEX approvals_status ON approvals(status, created_at);

CREATE TABLE usage_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('claude','codex')),
  window TEXT NOT NULL CHECK (window IN ('five_hour','weekly')),
  used_percent REAL NOT NULL,
  tokens INTEGER,
  resets_at TEXT,
  source TEXT NOT NULL
);
CREATE INDEX usage_latest ON usage_snapshots(agent, window, ts);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
