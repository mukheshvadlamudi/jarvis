-- Phase 2b: schedules and their run history.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  task_template_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  built_in TEXT,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  enabled_at TEXT
);
CREATE UNIQUE INDEX schedules_built_in ON schedules(built_in) WHERE built_in IS NOT NULL;

CREATE TABLE schedule_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  due_at TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('scheduled','manual','missed','skipped','failed')),
  task_id TEXT,
  note TEXT
);
CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule_id, ts);
