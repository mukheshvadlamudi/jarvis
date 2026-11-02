export type AgentId = 'claude' | 'codex';
export type TaskType = 'code' | 'research' | 'write' | 'admin' | 'update' | 'memory' | 'other';
export type TaskStatus = 'inbox' | 'queued' | 'running' | 'needs_you' | 'done' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  title: string;
  body: string;
  type: TaskType;
  status: TaskStatus;
  priority: number;
  project_id: string | null;
  agent_pref: 'auto' | AgentId;
  agent: AgentId | null;
  effort: 'low' | 'medium' | 'high';
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
  mode?: 'chat' | 'task';
}

export interface Run {
  id: string;
  task_id: string;
  agent: AgentId | 'mock';
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
  route_reason: string | null;
  prompt: string | null;
  context_report?: ContextReport | null;
  context_report_json?: string | null;
  model?: string | null;
  effort?: string | null;
  attachments_json?: string | null;
  answer?: string | null;
}

export interface ContextReport {
  items: Array<{ label: string; kind: string; path?: string; tokens: number; truncated?: boolean }>;
  totalTokens: number;
  budgetTokens: number;
  truncated: boolean;
}

export interface RunEvent {
  id: number;
  run_id: string;
  ts: string;
  kind: 'message' | 'tool_call' | 'tool_result' | 'file_change' | 'status' | 'usage' | 'error';
  payload: Record<string, any>;
}

export interface Approval {
  id: string;
  run_id: string | null;
  task_id: string | null;
  kind: string;
  summary: string;
  detail: { tool?: string; input?: Record<string, unknown>; reason?: string | null; agent?: AgentId; [k: string]: unknown };
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  created_at: string;
  decided_at: string | null;
  decided_via: string | null;
  note: string | null;
  task_title?: string | null;
  task_agent?: AgentId | null;
  live?: boolean;
}

export interface Project {
  id: string;
  name: string;
  kind: 'code' | 'client' | 'area';
  path: string | null;
  repo: string | null;
  vault_note: string | null;
  created_at: string;
  open_tasks?: number;
}

export interface UsageWindow {
  usedPercent: number;
  resetsAt: string | null;
  source: string;
  estimate: boolean;
  tokens: number | null;
  ts: string;
}
export type UsageState = Record<AgentId, { five_hour: UsageWindow | null; weekly: UsageWindow | null }>;
