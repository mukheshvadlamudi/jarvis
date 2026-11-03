ALTER TABLE runs ADD COLUMN purpose TEXT DEFAULT 'user_reply' CHECK (purpose IN ('user_reply', 'both', 'second_opinion', 'consult', 'learning', 'handoff', 'maintenance', 'verify'));
ALTER TABLE runs ADD COLUMN visibility TEXT DEFAULT 'conversation' CHECK (visibility IN ('conversation', 'activity', 'internal'));
ALTER TABLE runs ADD COLUMN owner_text TEXT;
ALTER TABLE runs ADD COLUMN parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;

UPDATE runs SET purpose = CASE
  WHEN route_reason LIKE 'side:both:%' THEN 'both'
  WHEN route_reason LIKE 'side:second opinion:%' THEN 'second_opinion'
  WHEN route_reason LIKE 'consult:%' THEN 'consult'
  WHEN route_reason LIKE 'learning%' THEN 'learning'
  WHEN task_id IN (SELECT id FROM tasks WHERE handoff_json IS NOT NULL) THEN 'handoff'
  WHEN task_id IN (SELECT t.id FROM tasks t JOIN schedules s ON s.id = t.schedule_id
    WHERE s.built_in = 'memory_consolidation' OR json_extract(s.task_template_json, '$.routine') = 'memory_consolidation') THEN 'maintenance'
  ELSE 'user_reply' END;
UPDATE runs SET visibility = CASE WHEN purpose = 'consult' THEN 'activity'
  WHEN purpose IN ('learning', 'maintenance', 'verify') THEN 'internal' ELSE 'conversation' END;
-- Recover legacy owner messages once; executable prompts are never parsed by readers.
UPDATE runs SET owner_text = CASE
  WHEN instr(prompt, char(10)||char(10)||'---'||char(10)||char(10)||'New message from the owner:'||char(10)) > 0
  THEN substr(prompt, instr(prompt, char(10)||char(10)||'---'||char(10)||char(10)||'New message from the owner:'||char(10)) + length(char(10)||char(10)||'---'||char(10)||char(10)||'New message from the owner:'||char(10)))
  ELSE prompt END WHERE purpose = 'user_reply';
UPDATE runs AS child SET parent_run_id = (SELECT parent.id FROM runs parent
  WHERE parent.task_id = child.task_id AND parent.purpose = 'user_reply'
  AND parent.started_at <= child.started_at ORDER BY parent.started_at DESC, parent.rowid DESC LIMIT 1)
  WHERE purpose IN ('both', 'second_opinion', 'consult', 'learning');
UPDATE runs SET parent_run_id = (SELECT parent.id FROM runs parent
  JOIN tasks t ON t.id = runs.task_id WHERE parent.id = json_extract(t.handoff_json, '$.fromRun'))
  WHERE purpose = 'handoff';
CREATE INDEX runs_task_purpose ON runs(task_id, purpose, started_at);
