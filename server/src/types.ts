export type AgentId = 'claude' | 'codex';
export type RunnerId = AgentId | 'mock';
export type TaskType = 'code' | 'research' | 'write' | 'admin' | 'update' | 'memory' | 'other';
export type TaskStatus = 'inbox' | 'queued' | 'running' | 'needs_you' | 'done' | 'failed' | 'cancelled';
export type AgentPref = 'auto' | AgentId;
export type Effort = 'low' | 'medium' | 'high';
/** A chat is a conversation on Ask (each message is a run); a task is background work on the Board. */
export type TaskMode = 'chat' | 'task';

export const TASK_TYPES: TaskType[] = ['code', 'research', 'write', 'admin', 'update', 'memory', 'other'];
export const TASK_STATUSES: TaskStatus[] = ['inbox', 'queued', 'running', 'needs_you', 'done', 'failed', 'cancelled'];

export interface Task {
  id: string;
  title: string;
  body: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  project_id: string | null;
  agent_pref: AgentPref;
  agent: AgentId | null;
  effort: Effort;
  parent_id: string | null;
  schedule_id: string | null;
  created_at: string;
  updated_at: string;
  due_at: string | null;
  result_summary: string | null;
  output_path: string | null;
  outward: number;
  route_reason: string | null;
  not_before: string | null;
  /** Handoff to run when this task finishes (JSON HandoffSpec). */
  then_json: string | null;
  /** Where this task was handed off from (JSON HandoffOrigin). */
  handoff_json: string | null;
  mode: TaskMode;
}

export interface Run {
  id: string;
  task_id: string;
  agent: string;
  session_id: string | null;
  cwd: string;
  started_at: string;
  ended_at: string | null;
  status: 'running' | 'done' | 'failed' | 'cancelled';
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  cost_estimate_usd: number;
  tool_calls: number;
  error: string | null;
  context_report_json: string | null;
  route_reason: string | null;
  prompt: string | null;
  model: string | null;
  effort: string | null;
  /** JSON Attachment[] given to this run. */
  attachments_json: string | null;
  /** The run's final answer (capped), for conversation history and search. */
  answer: string | null;
}

/** A file the owner attached, as handed to a run (path is inside the run's working folder). */
export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  path: string;
}

export type RunEventKind = 'message' | 'tool_call' | 'tool_result' | 'file_change' | 'status' | 'usage' | 'error';

export interface StoredRunEvent {
  id: number;
  run_id: string;
  ts: string;
  kind: RunEventKind;
  payload_json: string;
}

export interface Approval {
  id: string;
  run_id: string | null;
  task_id: string | null;
  kind: string;
  summary: string;
  detail_json: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  created_at: string;
  decided_at: string | null;
  decided_via: string | null;
  note: string | null;
}

export interface Project {
  id: string;
  name: string;
  kind: 'code' | 'client' | 'area';
  path: string | null;
  repo: string | null;
  vault_note: string | null;
  created_at: string;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAt: string | null;
  source: string;
  estimate: boolean;
  tokens: number | null;
  ts: string;
}

export interface AgentUsage {
  five_hour: UsageWindow | null;
  weekly: UsageWindow | null;
}

export type UsageState = Record<AgentId, AgentUsage>;
