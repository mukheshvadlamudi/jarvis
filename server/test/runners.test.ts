import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ThreadEvent } from '@openai/codex-sdk';
import { describe, expect, it } from 'vitest';
import { buildClaudeOptions, createClaudeRunner, rateLimitToReading } from '../src/runners/claude.ts';
import type { QueryFn } from '../src/runners/claude.ts';
import { buildCodexOptions, createCodexRunner } from '../src/runners/codex.ts';
import type { CodexFactory } from '../src/runners/codex.ts';
import type { ApprovalRequest, NormalizedEvent, RunEventSink, RunInput } from '../src/runners/types.ts';

const input: RunInput = {
  taskId: 't_1', runId: 'r_1', prompt: 'Fix the bug', contextPrefix: 'CTX', cwd: '/work/t_1', sandbox: 'workspace-write',
  allowNetwork: false, taskType: 'code', vaultPath: '/vault',
  mcpServers: { jarvis: { command: 'node', args: ['mcp.ts', '--run', 'r_1'], env: { JARVIS_MCP_TOKEN: 'tok', OPENAI_API_KEY: 'leak' } } },
};
const dirtyEnv = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', CODEX_API_KEY: 'x', ANTHROPIC_AUTH_TOKEN: 'y' };

function sink(decide: (r: ApprovalRequest) => boolean = () => true) {
  const events: NormalizedEvent[] = [];
  const approvals: ApprovalRequest[] = [];
  const readings: unknown[] = [];
  let session = '';
  const s: RunEventSink = {
    emit: (e) => events.push(e),
    setSessionId: (id) => (session = id),
    requestApproval: async (r) => {
      approvals.push(r);
      const ok = decide(r);
      return { approved: ok, status: ok ? 'approved' : 'rejected', note: ok ? undefined : 'not now' };
    },
    rateLimit: (r) => readings.push(r),
  };
  return { s, events, approvals, readings, session: () => session };
}

const sdk = (m: unknown) => m as SDKMessage;

describe('claude runner (SDK mocked)', () => {
  it('builds plan-only options: no API keys, hooks, canUseTool, MCP, project settings', () => {
    const { s } = sink();
    const o = buildClaudeOptions(input, s, new AbortController(), dirtyEnv);
    expect(o.env).toEqual({ PATH: '/bin', HOME: '/h', CLAUDE_AGENT_SDK_CLIENT_APP: 'jarvis/0.1', MCP_TIMEOUT: '8000' });
    expect(o.cwd).toBe('/work/t_1');
    expect(o.permissionMode).toBe('acceptEdits');
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'CTX' });
    expect(o.mcpServers?.jarvis).toEqual({ type: 'stdio', command: 'node', args: ['mcp.ts', '--run', 'r_1'], env: { JARVIS_MCP_TOKEN: 'tok' } });
    expect(typeof o.canUseTool).toBe('function');
    expect(o.hooks?.PreToolUse?.length).toBe(1);
  });

  it('routes risky tools through approvals and blocks credential access', async () => {
    const { s, approvals } = sink((r) => r.kind !== 'pull_request');
    const o = buildClaudeOptions(input, s, new AbortController(), {});
    const opts = { signal: new AbortController().signal, toolUseID: 'x' } as Parameters<NonNullable<typeof o.canUseTool>>[2];
    expect(await o.canUseTool!('Bash', { command: 'npm test' }, opts)).toMatchObject({ behavior: 'allow' });
    expect(await o.canUseTool!('Bash', { command: 'git push origin main' }, opts)).toMatchObject({ behavior: 'allow' });
    expect(await o.canUseTool!('Bash', { command: 'gh pr create --fill' }, opts)).toMatchObject({ behavior: 'deny' });
    expect(await o.canUseTool!('Read', { file_path: '/h/.claude/.credentials.json' }, opts)).toMatchObject({ behavior: 'deny' });
    expect(approvals.map((a) => a.kind)).toEqual(['git_push', 'pull_request']);
    expect(approvals[0].summary).toBe('Push main to origin');
    const hook = o.hooks!.PreToolUse![0].hooks[0];
    const pre = (tool: string, toolInput: unknown) => hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: toolInput, tool_use_id: 'u', session_id: 's', transcript_path: '', cwd: '/work/t_1' } as never, 'u', { signal: new AbortController().signal });
    expect(await pre('Bash', { command: 'git push' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
    expect(await pre('Bash', { command: 'cat ~/.codex/auth.json' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await pre('Bash', { command: 'ls' })).toEqual({});
  });

  it('denies writes in read-only runs', async () => {
    const { s } = sink();
    const o = buildClaudeOptions({ ...input, sandbox: 'read-only' }, s, new AbortController(), {});
    expect(o.permissionMode).toBe('default');
    const r = await o.canUseTool!('Write', { file_path: '/work/t_1/a.md' }, { signal: new AbortController().signal, toolUseID: 'x' } as never);
    expect(r?.behavior).toBe('deny');
  });

  it('maps SDK messages to normalized events and totals', async () => {
    const messages = [
      sdk({ type: 'system', subtype: 'init', session_id: 'sess-1', apiKeySource: 'none', claude_code_version: '2.3.0', model: 'claude-sonnet-5-5' }),
      sdk({ type: 'assistant', parent_tool_use_id: null, session_id: 'sess-1', message: { content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b\nc' } }] } }),
      sdk({ type: 'user', parent_tool_use_id: null, session_id: 'sess-1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'ok' }] }] } }),
      sdk({ type: 'rate_limit_event', session_id: 'sess-1', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.82, resetsAt: 1762100000 } }),
      sdk({ type: 'result', subtype: 'success', is_error: false, result: 'Fixed it.', session_id: 'sess-1', num_turns: 2, duration_ms: 5000, total_cost_usd: 0.12, usage: { input_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 900, output_tokens: 40 } }),
    ];
    let seen: Parameters<QueryFn>[0] | undefined;
    const queryFn: QueryFn = (params) => {
      seen = params;
      return (async function* () {
        for (const m of messages) yield m;
      })();
    };
    const { s, events, readings, session } = sink();
    const result = await createClaudeRunner({ queryFn, env: dirtyEnv }).start(input, s).done;
    expect(seen?.prompt).toBe('Fix the bug');
    expect(seen?.options?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(session()).toBe('sess-1');
    expect(events.map((e) => e.kind)).toEqual(['status', 'message', 'tool_call', 'file_change', 'tool_result', 'usage']);
    expect(events[3].payload).toMatchObject({ path: 'a.ts', additions: 2, deletions: 1 });
    expect(readings).toEqual([{ agent: 'claude', window: 'five_hour', usedPercent: 82, resetsAt: new Date(1762100000 * 1000).toISOString(), source: 'claude-sdk' }]);
    expect(result).toMatchObject({ status: 'done', summary: 'Fixed it.', sessionId: 'sess-1', toolCalls: 1, usage: { inputTokens: 150, outputTokens: 40, cachedTokens: 900, costUsd: 0.12 } });
  });

  it('aborts if the CLI reports API-key billing', async () => {
    const queryFn: QueryFn = () => (async function* () {
      yield sdk({ type: 'system', subtype: 'init', session_id: 's', apiKeySource: 'ANTHROPIC_API_KEY', claude_code_version: '2', model: 'm' });
    })();
    const r = await createClaudeRunner({ queryFn }).start(input, sink().s).done;
    expect(r).toMatchObject({ status: 'failed', error: 'api_key_billing' });
  });

  it('reports failures and cancellation', async () => {
    const failing: QueryFn = () => (async function* () {
      yield sdk({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['Reached max turns'], session_id: 's', usage: {}, num_turns: 50, duration_ms: 1, total_cost_usd: 0 });
    })();
    expect(await createClaudeRunner({ queryFn: failing }).start(input, sink().s).done).toMatchObject({ status: 'failed', summary: 'Reached max turns' });

    let interrupted = false;
    const slow: QueryFn = (p) => {
      const gen = (async function* () {
        await new Promise((_, reject) => p.options!.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
        yield sdk({});
      })();
      return Object.assign(gen, { interrupt: async () => { interrupted = true; } });
    };
    const h = createClaudeRunner({ queryFn: slow }).start(input, sink().s);
    await h.cancel();
    expect((await h.done).status).toBe('cancelled');
    expect(interrupted).toBe(true);
  });

  it('maps rate-limit percentages given as fractions or percents', () => {
    expect(rateLimitToReading({ status: 'allowed', rateLimitType: 'seven_day', utilization: 41 })).toMatchObject({ window: 'weekly', usedPercent: 41 });
    expect(rateLimitToReading({ status: 'rejected', rateLimitType: 'five_hour' })).toMatchObject({ usedPercent: 100 });
    expect(rateLimitToReading({ status: 'allowed', rateLimitType: 'overage', utilization: 0.1 })).toBeNull();
  });
});

describe('codex runner (SDK mocked)', () => {
  it('always passes an explicit sandbox, a clean env and MCP config overrides', () => {
    const { codex, thread } = buildCodexOptions({ ...input, sandbox: 'read-only', webSearch: true, allowNetwork: true }, dirtyEnv);
    expect(codex.env).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(codex.apiKey).toBeUndefined();
    expect(codex.config).toEqual({ mcp_servers: { jarvis: { command: 'node', args: ['mcp.ts', '--run', 'r_1'], env: { JARVIS_MCP_TOKEN: 'tok' }, enabled_tools: ['search_memory', 'search_conversations', 'read_note', 'list_projects', 'get_usage', 'save_memory', 'request_approval', 'consult_agent', 'handoff_to_agent', 'create_task'], default_tools_approval_mode: 'prompt', tools: Object.fromEntries(['search_memory', 'search_conversations', 'read_note', 'list_projects', 'get_usage', 'save_memory', 'request_approval', 'consult_agent', 'handoff_to_agent', 'create_task'].map((name) => [name, { approval_mode: 'approve' }])) } } });
    expect(thread).toMatchObject({ sandboxMode: 'read-only', approvalPolicy: 'never', skipGitRepoCheck: true, networkAccessEnabled: true, webSearchMode: 'live', workingDirectory: '/work/t_1' });
    expect(buildCodexOptions(input, {}).thread.sandboxMode).toBe('workspace-write');
  });

  function fakeFactory(events: ThreadEvent[], record: { started?: unknown; resumed?: string; prompt?: string; options?: unknown }): CodexFactory {
    return (options) => {
      record.options = options;
      const thread = {
        id: 'th-1',
        async runStreamed(prompt: string) {
          record.prompt = prompt;
          return { events: (async function* () { for (const e of events) yield e; })() };
        },
      };
      return {
        startThread: (o) => { record.started = o; return thread; },
        resumeThread: (id) => { record.resumed = id; return thread; },
      };
    };
  }

  it('maps thread items to normalized events', async () => {
    const events: ThreadEvent[] = [
      { type: 'thread.started', thread_id: 'th-1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ path: 'a.ts', kind: 'update' }, { path: 'b.ts', kind: 'add' }], status: 'completed' } },
      { type: 'item.started', item: { id: 'm1', type: 'mcp_tool_call', server: 'jarvis', tool: 'search_memory', arguments: { query: 'x' }, status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'jarvis', tool: 'search_memory', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: '2 notes' }], structured_content: null } } },
      { type: 'item.started', item: { id: 'w1', type: 'web_search', query: 'pg backups' } },
      { type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'All done.' } },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 20 } },
    ];
    const rec: Record<string, any> = {};
    const { s, events: out, session } = sink();
    const r = await createCodexRunner({ factory: fakeFactory(events, rec), env: dirtyEnv }).start(input, s).done;
    expect(rec.options.env.OPENAI_API_KEY).toBeUndefined();
    expect(rec.started.sandboxMode).toBe('workspace-write');
    expect(rec.prompt.startsWith('CTX')).toBe(true);
    expect(session()).toBe('th-1');
    expect(out.map((e) => e.kind)).toEqual(['status', 'tool_call', 'tool_result', 'file_change', 'file_change', 'tool_call', 'tool_result', 'tool_call', 'message', 'usage']);
    expect(out[6].payload).toMatchObject({ tool: 'mcp__jarvis__search_memory', output: '2 notes' });
    expect(r).toMatchObject({ status: 'done', summary: 'All done.', toolCalls: 3, sessionId: 'th-1', usage: { inputTokens: 1000, cachedTokens: 800, outputTokens: 120 } });
  });

  it('resumes threads with only the follow-up text and reports failures', async () => {
    const rec: Record<string, any> = {};
    const r = await createCodexRunner({ factory: fakeFactory([{ type: 'turn.failed', error: { message: 'usage limit reached' } }], rec) })
      .start({ ...input, resumeSessionId: 'th-9', prompt: 'and also X' }, sink().s).done;
    expect(rec.resumed).toBe('th-9');
    expect(rec.prompt).toBe('and also X');
    expect(r).toMatchObject({ status: 'failed', error: 'usage limit reached' });
  });
});

describe('harness effort and model', () => {
  it('passes effort and model to Claude Code and Codex only when set', () => {
    const { s } = sink();
    const c = buildClaudeOptions({ ...input, effort: 'high', model: 'claude-opus-5-5' }, s, new AbortController(), {});
    expect(c).toMatchObject({ effort: 'high', model: 'claude-opus-5-5' });
    expect('effort' in buildClaudeOptions(input, s, new AbortController(), {})).toBe(false);
    const x = buildCodexOptions({ ...input, effort: 'xhigh', model: 'gpt-5.3-codex' }, {});
    expect(x.thread).toMatchObject({ modelReasoningEffort: 'xhigh', model: 'gpt-5.3-codex' });
    expect('modelReasoningEffort' in buildCodexOptions(input, {}).thread).toBe(false);
  });
});
