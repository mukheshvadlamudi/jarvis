import type { AgentId, RunEventKind, TaskType } from '../types.ts';

/** Stdio MCP server definition handed to both agents. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface RunInput {
  taskId: string;
  /** Which agent this run is for (informational; the registry already picked the runner). */
  agent?: AgentId;
  runId: string;
  prompt: string;
  contextPrefix: string;
  cwd: string;
  resumeSessionId?: string;
  sandbox: 'read-only' | 'workspace-write';
  allowNetwork: boolean;
  taskType: TaskType;
  /** Research tasks get live web search on Codex. */
  webSearch?: boolean;
  /** Extra directories the agent may touch (e.g. the vault). */
  additionalDirectories?: string[];
  mcpServers?: Record<string, McpServerSpec>;
  vaultPath?: string;
  /** Harness effort for this run (agent-specific value); undefined = CLI default. */
  effort?: string;
  /** Model override; undefined = CLI/plan default. */
  model?: string;
}

export interface NormalizedEvent {
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface ApprovalRequest {
  kind: string;
  summary: string;
  reason?: string;
  detail: Record<string, unknown>;
}

export interface ApprovalDecision {
  approved: boolean;
  note?: string;
  status: 'approved' | 'rejected' | 'expired';
}

export interface RateLimitReading {
  agent: AgentId;
  window: 'five_hour' | 'weekly';
  usedPercent: number;
  resetsAt: string | null;
  source: string;
}

export interface RunEventSink {
  emit(event: NormalizedEvent): void;
  setSessionId(id: string): void;
  requestApproval(req: ApprovalRequest): Promise<ApprovalDecision>;
  rateLimit(reading: RateLimitReading): void;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
}

export interface RunResult {
  status: 'done' | 'failed' | 'cancelled';
  summary: string;
  sessionId?: string;
  usage: RunUsage;
  toolCalls: number;
  error?: string;
}

export interface RunHandle {
  done: Promise<RunResult>;
  cancel(): Promise<void>;
  sendFollowUp?(text: string): Promise<void>;
}

export interface AgentRunner {
  readonly id: 'claude' | 'codex' | 'mock';
  start(input: RunInput, sink: RunEventSink): RunHandle;
}

export const emptyUsage = (): RunUsage => ({ inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 });

/** Short one-line description of a tool call for transcript rows. */
export function describeToolInput(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  const target =
    pick('command') ?? pick('file_path') ?? pick('path') ?? pick('pattern') ?? pick('url') ?? pick('query') ?? pick('description') ?? '';
  const oneLine = target.replace(/\s+/g, ' ').trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine || tool;
}
