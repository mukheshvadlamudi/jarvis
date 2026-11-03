-- Preserve historical purpose values while replacing the column's CHECK constraint.
DROP INDEX runs_task_purpose;
ALTER TABLE runs ADD COLUMN purpose_saved TEXT;
UPDATE runs SET purpose_saved = purpose;
ALTER TABLE runs DROP COLUMN purpose;
ALTER TABLE runs ADD COLUMN purpose TEXT DEFAULT 'user_reply' CHECK (purpose IN ('user_reply','both','second_opinion','consult','learning','handoff','maintenance','verify','workflow_step'));
UPDATE runs SET purpose = purpose_saved;
ALTER TABLE runs DROP COLUMN purpose_saved;
CREATE INDEX runs_task_purpose ON runs(task_id, purpose, started_at);

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('running','waiting_approval','done','failed','cancelled')),
  current_step INTEGER NOT NULL DEFAULT 0,
  step_results_json TEXT NOT NULL DEFAULT '{}',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  definition_json TEXT NOT NULL,
  input TEXT NOT NULL DEFAULT '',
  error TEXT
);
CREATE INDEX workflow_runs_conversation ON workflow_runs(conversation_id, started_at);
CREATE UNIQUE INDEX workflow_runs_active ON workflow_runs(conversation_id) WHERE status IN ('running','waiting_approval');
