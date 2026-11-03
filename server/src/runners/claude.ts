/**
 * Claude Code runner, coded against @anthropic-ai/claude-agent-sdk's shipped sdk.d.ts.
 * Uses the owner's saved Claude login (no API keys: they are stripped from the child env).
 */
import type {
  CanUseTool,
  HookCallback,
  McpServerConfig,
  Options,
  PermissionResult,
  SDKMessage,
  SDKRateLimitInfo,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ConfigStore, REPO_ROOT } from '../config.ts';
import { classifyToolCall, humanSummary } from '../approvals/policy.ts';
import { sanitizedAgentEnv } from '../util/env.ts';
import type { AgentRunner, RunEventSink, RunHandle, RunInput, RunResult } from './types.ts';
import { describeToolInput, emptyUsage } from './types.ts';
import { attachmentNote, inlineKind } from './attachments.ts';

/** The subset of the SDK `Query` object Jarvis uses; lets tests inject a fake. */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  interrupt?: () => Promise<unknown>;
  close?: () => void;
}
export type QueryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => QueryLike;

export interface ClaudeRunnerDeps {
  queryFn?: QueryFn;
  env?: NodeJS.ProcessEnv;
  chrome?: () => boolean;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

async function loadQuery(): Promise<QueryFn> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  return sdk.query as unknown as QueryFn;
}

function lineCount(v: unknown): number {
  return typeof v === 'string' && v.length ? v.split('\n').length : 0;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { type?: string }).type === 'text' ? String((b as { text?: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content);
}

/** Map an SDK rate-limit event to a plan-window reading. */
export function rateLimitToReading(info: SDKRateLimitInfo): { window: 'five_hour' | 'weekly'; usedPercent: number; resetsAt: string | null } | null {
  const type = info.rateLimitType;
  if (!type || type === 'overage') return null;
  const window = type === 'five_hour' ? 'five_hour' : 'weekly';
  let pct: number;
  if (typeof info.utilization === 'number') pct = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
  else if (info.status === 'rejected') pct = 100;
  else return null;
  const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt).toISOString() : null;
  return { window, usedPercent: Math.max(0, Math.min(100, pct)), resetsAt };
}

/**
 * The run's prompt. Plain text unless images or PDFs are attached: those go in the message itself
 * (base64 content blocks over streaming input), so Claude sees them without a tool call.
 */
export function buildClaudePrompt(input: RunInput): string | AsyncIterable<SDKUserMessage> {
  const text = `${input.prompt}${attachmentNote(input.attachments)}`;
  const inline = (input.attachments ?? []).filter((a) => inlineKind(a, 'claude'));
  if (!inline.length) return text;
  const content: Array<Record<string, unknown>> = [{ type: 'text', text }];
  for (const a of inline) {
    const data = readFileSync(a.path).toString('base64');
    content.push(inlineKind(a, 'claude') === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: a.mime, data } }
      : { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: a.name });
  }
  const message = { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null } as unknown as SDKUserMessage;
  return (async function* () {
    yield message;
  })();
}

/** Thinking summaries need the adaptive-thinking models; older pinned ids keep their own default. */
const ADAPTIVE = /^(default|opus|sonnet|fable|haiku)$|^claude-(opus|sonnet|fable|haiku)-[5-9]/;

/** Build the SDK options for one run. Exported for unit tests. */
export function buildClaudeOptions(input: RunInput, sink: RunEventSink, abortController: AbortController, env: NodeJS.ProcessEnv, chrome = false): Options {
  const readOnly = input.sandbox === 'read-only';

  const policyFor = (toolName: string, toolInput: Record<string, unknown>) => {
    if (readOnly && WRITE_TOOLS.has(toolName)) {
      return { level: 'block' as const, kind: 'read_only', reason: 'this task runs read-only' };
    }
    // A click, keystroke, script or batch can submit outward data. Gate all browser mutations;
    // the extension's per-site permissions remain an additional control.
    if (/^mcp__claude[-_]in[-_]chrome__/.test(toolName) &&
        !/(?:__)(read_page|find|read_console_messages|read_network_requests|tabs_context_mcp|get_page_text)$/.test(toolName)) {
      return { level: 'ask' as const, kind: 'browser_action', reason: 'browser input can submit forms, send messages or make purchases' };
    }
    return classifyToolCall({ tool: toolName, input: toolInput, cwd: input.cwd, vault: input.vaultPath });
  };

  // PreToolUse runs for every tool call regardless of the owner's own allow rules, so risky calls
  // are always forced through canUseTool (ask) or denied (block).
  const preToolUse: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name !== 'PreToolUse') return {};
    const toolInput = (hookInput.tool_input ?? {}) as Record<string, unknown>;
    const verdict = policyFor(hookInput.tool_name, toolInput);
    if (verdict.level === 'block') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by Jarvis policy: ${verdict.reason}` } };
    }
    if (verdict.level === 'ask') {
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `Jarvis needs owner approval: ${verdict.reason}` } };
    }
    return {};
  };

  const canUseTool: CanUseTool = async (toolName, toolInput): Promise<PermissionResult> => {
    const verdict = policyFor(toolName, toolInput);
    if (verdict.level === 'block') return { behavior: 'deny', message: `Blocked by Jarvis policy: ${verdict.reason}` };
    if (verdict.level === 'safe') return { behavior: 'allow', updatedInput: toolInput };
    const decision = await sink.requestApproval({
      kind: verdict.kind,
      summary: humanSummary(verdict.kind, toolName, toolInput),
      reason: verdict.reason,
      detail: { tool: toolName, input: toolInput },
    });
    if (decision.approved) return { behavior: 'allow', updatedInput: toolInput };
    return { behavior: 'deny', message: `The owner ${decision.status} this action${decision.note ? `: ${decision.note}` : ''}. Do not retry it; continue without it or stop.` };
  };

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(input.mcpServers ?? {})) {
    mcpServers[name] = { type: 'stdio', command: spec.command, args: spec.args, env: sanitizedAgentEnv(spec.env, {}) };
  }

  return {
    ...(chrome ? { extraArgs: { chrome: null } } : {}),
    cwd: input.cwd,
    resume: input.resumeSessionId,
    abortController,
    permissionMode: readOnly ? 'default' : 'acceptEdits',
    canUseTool,
    hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
    mcpServers,
    // user = synced skills in ~/.claude/skills; project/local = the repo's CLAUDE.md and settings.
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: input.contextPrefix },
    additionalDirectories: input.additionalDirectories,
    // Claude Code waits for every connector before the first turn (30 s default). Plugin connectors
    // that never connect made each answer start 30 s late; 8 s keeps healthy ones and fails the rest.
    env: sanitizedAgentEnv(env, { CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis/0.1', MCP_TIMEOUT: env.MCP_TIMEOUT ?? env.JARVIS_CLAUDE_MCP_TIMEOUT_MS ?? '8000' }),
    ...(input.effort ? { effort: input.effort as NonNullable<Options['effort']> } : {}),
    ...(input.model ? { model: input.model } : {}),
    // Stream text and thinking as they are written, so Ask shows the answer forming live.
    includePartialMessages: true,
    ...(!input.model || ADAPTIVE.test(input.model) ? { thinking: { type: 'adaptive', display: 'summarized' } as const } : {}),
  };
}

export function createClaudeRunner(deps: ClaudeRunnerDeps = {}): AgentRunner {
  return {
    id: 'claude',
    start(input: RunInput, sink: RunEventSink): RunHandle {
      const abortController = new AbortController();
      let q: QueryLike | null = null;
      let cancelled = false;

      const done = (async (): Promise<RunResult> => {
        const usage = emptyUsage();
        let toolCalls = 0;
        let sessionId: string | undefined = input.resumeSessionId;
        let finalText = '';
        let lastAssistantText = '';
        const toolNames = new Map<string, string>();
        try {
          const queryFn = deps.queryFn ?? (await loadQuery());
          const env = deps.env ?? process.env;
          const dataDir = resolve(REPO_ROOT, env.JARVIS_DATA_DIR || 'data');
          const chrome = deps.chrome?.() ?? (!deps.queryFn && new ConfigStore(dataDir).get().agents.claude.chrome);
          const options = buildClaudeOptions(input, sink, abortController, env, chrome);
          if (input.taskId === 'verify' && chrome && !deps.queryFn) {
            mkdirSync(dataDir, { recursive: true });
            writeFileSync(join(dataDir, 'chrome-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ok: false }));
          }
          q = queryFn({ prompt: buildClaudePrompt(input), options });
          for await (const m of q) {
            if (m.type === 'system' && m.subtype === 'init') {
              sessionId = m.session_id;
              sink.setSessionId(m.session_id);
              if (m.apiKeySource === 'ANTHROPIC_API_KEY') {
                // Belt and braces: never let a run bill the API instead of the plan.
                sink.emit({ kind: 'error', payload: { message: 'Claude reported API-key billing; aborting to protect your plan-only setup.' } });
                abortController.abort();
                return { status: 'failed', summary: 'Aborted: Claude was about to use an API key instead of your plan login.', error: 'api_key_billing', sessionId, usage, toolCalls };
              }
              sink.emit({ kind: 'status', payload: { status: 'started', detail: `Claude Code ${m.claude_code_version} · ${m.model}`, sessionId: m.session_id } });
            } else if (m.type === 'stream_event') {
              if (m.parent_tool_use_id || !sink.live) continue;
              const ev = m.event as { type: string; delta?: { type?: string; text?: string; thinking?: string } };
              if (ev.type === 'message_start') sink.live({ kind: 'reset' });
              else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) sink.live({ kind: 'text', text: ev.delta.text });
              else if (ev.type === 'content_block_delta' && ev.delta?.type === 'thinking_delta' && ev.delta.thinking) sink.live({ kind: 'thinking', text: ev.delta.thinking });
            } else if (m.type === 'assistant') {
              if (m.parent_tool_use_id) continue; // subagent chatter stays out of the transcript
              for (const block of m.message.content) {
                if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
                  sink.emit({ kind: 'message', payload: { role: 'reasoning', text: block.thinking } });
                } else if (block.type === 'text' && block.text.trim()) {
                  lastAssistantText = block.text;
                  sink.emit({ kind: 'message', payload: { role: 'assistant', text: block.text } });
                } else if (block.type === 'tool_use') {
                  toolCalls++;
                  const toolInput = (block.input ?? {}) as Record<string, unknown>;
                  toolNames.set(block.id, block.name);
                  sink.emit({ kind: 'tool_call', payload: { id: block.id, tool: block.name, input: toolInput, summary: describeToolInput(block.name, toolInput) } });
                  if (WRITE_TOOLS.has(block.name) && typeof (toolInput.file_path ?? toolInput.notebook_path) === 'string') {
                    const additions = lineCount(toolInput.content) + lineCount(toolInput.new_string) +
                      (Array.isArray(toolInput.edits) ? toolInput.edits.reduce((n: number, e: { new_string?: unknown }) => n + lineCount(e?.new_string), 0) : 0);
                    const deletions = lineCount(toolInput.old_string) +
                      (Array.isArray(toolInput.edits) ? toolInput.edits.reduce((n: number, e: { old_string?: unknown }) => n + lineCount(e?.old_string), 0) : 0);
                    sink.emit({ kind: 'file_change', payload: { path: toolInput.file_path ?? toolInput.notebook_path, kind: block.name === 'Write' ? 'add' : 'update', additions, deletions } });
                  }
                }
              }
            } else if (m.type === 'user') {
              if (m.parent_tool_use_id) continue;
              const content = m.message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block && typeof block === 'object' && block.type === 'tool_result') {
                    sink.emit({
                      kind: 'tool_result',
                      payload: { id: block.tool_use_id, tool: toolNames.get(block.tool_use_id) ?? null, output: toolResultText(block.content), isError: block.is_error === true },
                    });
                  }
                }
              }
            } else if (m.type === 'rate_limit_event') {
              const reading = rateLimitToReading(m.rate_limit_info);
              if (reading) sink.rateLimit({ agent: 'claude', ...reading, source: 'claude-sdk' });
            } else if (m.type === 'result') {
              sessionId = m.session_id;
              usage.inputTokens = (m.usage.input_tokens ?? 0) + (m.usage.cache_creation_input_tokens ?? 0);
              usage.outputTokens = m.usage.output_tokens ?? 0;
              usage.cachedTokens = m.usage.cache_read_input_tokens ?? 0;
              usage.costUsd = m.total_cost_usd ?? 0;
              sink.emit({ kind: 'usage', payload: { ...usage, turns: m.num_turns, durationMs: m.duration_ms } });
              if (m.subtype === 'success' && !m.is_error) {
                finalText = m.result;
              } else {
                const errors = 'errors' in m && Array.isArray(m.errors) ? m.errors.join('; ') : '';
                const message = errors || (m.subtype === 'success' ? m.result : m.subtype);
                sink.emit({ kind: 'error', payload: { message } });
                return { status: 'failed', summary: message, error: message, sessionId, usage, toolCalls };
              }
            }
          }
          if (cancelled) return { status: 'cancelled', summary: 'Cancelled by you.', sessionId, usage, toolCalls };
          const summary = (finalText || lastAssistantText || 'Finished.').trim();
          // Setup's existing tiny verification run also verifies startup with --chrome.
          if (input.taskId === 'verify' && chrome && !deps.queryFn) {
            mkdirSync(dataDir, { recursive: true });
            writeFileSync(join(dataDir, 'chrome-check.json'), JSON.stringify({ checkedAt: new Date().toISOString(), ok: true }));
          }
          return { status: 'done', summary, sessionId, usage, toolCalls };
        } catch (err) {
          if (cancelled || abortController.signal.aborted) return { status: 'cancelled', summary: 'Cancelled by you.', sessionId, usage, toolCalls };
          const message = err instanceof Error ? err.message : String(err);
          sink.emit({ kind: 'error', payload: { message } });
          return { status: 'failed', summary: message, error: message, sessionId, usage, toolCalls };
        }
      })();

      return {
        done,
        async cancel() {
          cancelled = true;
          try {
            await q?.interrupt?.();
          } catch {
            // interrupt is best-effort; abort below always stops the process
          }
          abortController.abort();
          q?.close?.();
        },
      };
    },
  };
}
