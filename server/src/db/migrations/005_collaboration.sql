-- Agent collaboration: a handoff planned on a task (then_json) and the handoff a task came from (handoff_json).
ALTER TABLE tasks ADD COLUMN then_json TEXT;
ALTER TABLE tasks ADD COLUMN handoff_json TEXT;
