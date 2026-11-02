/**
 * Codex runner, coded against @openai/codex-sdk's shipped dist/index.d.ts.
 * Uses the owner's saved ChatGPT login: `env` is passed explicitly (so the SDK does not inherit
 * process.env) with every API-key variable removed, and no `apiKey` option is ever set.
 */
import type { CodexOptions, ThreadEvent, ThreadItem, ThreadOptions, TurnOptions } from '@openai/codex-sdk';
import { sanitizedAgentEnv } from '../util/env.ts';
import type { AgentRunner, RunEventSink, RunHandle, RunInput, RunResult } from './types.ts';
import { emptyUsage } from './types.ts';

/** The subset of the SDK the runner needs; tests inject a fake. */
export interface ThreadLike {
  readonly id: string | null;
  runStreamed(input: string, turnOptions?: TurnOptions): Promise<{ events: AsyncGenerator<ThreadEvent> }>;
}
export interface CodexLike {
  startThread(options?: ThreadOptions): ThreadLike;
  resumeThread(id: string, options?: ThreadOptions): ThreadLike;
}
export type CodexFactory = (options: CodexOptions) => CodexLike;

export interface CodexRunnerDeps {
  factory?: CodexFactory;
  env?: NodeJS.ProcessEnv;
}

async function loadFactory(): Promise<CodexFactory> {
  const sdk = await import('@openai/codex-sdk');
  return (options) => new sdk.Codex(options);
}

/** SDK options for one run. MCP servers go in as `--config mcp_servers.*` overrides. Exported for tests. */
export function buildCodexOptions(input: RunInput, env: NodeJS.ProcessEnv): { codex: CodexOptions; thread: ThreadOptions } {
  const config: NonNullable<CodexOptions['config']> = {};
  const servers = Object.entries(input.mcpServers ?? {});
  if (servers.length) {
    const mcp: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
    for (const [name, spec] of servers) mcp[name] = { command: spec.command, args: spec.args, env: spec.env };
    config.mcp_servers = mcp;
  }
  const thread: ThreadOptions = {
    workingDirectory: input.cwd,
    // Always explicit: the owner's global config uses danger-full-access and must never be inherited.
    sandboxMode: input.sandbox,
    approvalPolicy: 'never',
    skipGitRepoCheck: true,
    networkAccessEnabled: input.allowNetwork,
    webSearchMode: input.webSearch ? 'live' : 'disabled',
    additionalDirectories: input.additionalDirectories,
  };
  return { codex: { env: sanitizedAgentEnv(env), config }, thread };
}

function itemEvents(item: ThreadItem, phase: 'started' | 'updated' | 'completed', sink: RunEventSink, counters: { toolCalls: number }): string | null {
  switch (item.type) {
    case 'agent_message':
      if (phase === 'completed' && item.text.trim()) {
        sink.emit({ kind: 'message', payload: { role: 'assistant', text: item.text } });
        return item.text;
      }
      return null;
    case 'reasoning':
      if (phase === 'completed' && item.text.trim()) sink.emit({ kind: 'message', payload: { role: 'reasoning', text: item.text } });
      return null;
    case 'command_execution':
      if (phase === 'started') {
        counters.toolCalls++;
        sink.emit({ kind: 'tool_call', payload: { id: item.id, tool: 'shell', input: { command: item.command }, summary: item.command } });
      } else if (phase === 'completed') {
        sink.emit({ kind: 'tool_result', payload: { id: item.id, tool: 'shell', output: item.aggregated_output, exitCode: item.exit_code ?? null, isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0 } });
      }
      return null;
    case 'file_change':
      if (phase === 'completed') {
        for (const c of item.changes) sink.emit({ kind: 'file_change', payload: { path: c.path, kind: c.kind, status: item.status } });
      }
      return null;
    case 'mcp_tool_call':
      if (phase === 'started') {
        counters.toolCalls++;
        sink.emit({ kind: 'tool_call', payload: { id: item.id, tool: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {} } });
      } else if (phase === 'completed') {
        const text = item.error?.message ?? (item.result?.content ?? []).map((b) => ('text' in b && typeof b.text === 'string' ? b.text : '')).join('\n');
        sink.emit({ kind: 'tool_result', payload: { id: item.id, tool: `mcp__${item.server}__${item.tool}`, output: text, isError: item.status === 'failed' } });
      }
      return null;
    case 'web_search':
      if (phase === 'started') {
        counters.toolCalls++;
        sink.emit({ kind: 'tool_call', payload: { id: item.id, tool: 'web_search', input: { query: item.query }, summary: item.query } });
      } else if (phase === 'completed') {
        sink.emit({ kind: 'tool_result', payload: { id: item.id, tool: 'web_search', output: `Searched: ${item.query}` } });
      }
      return null;
    case 'todo_list':
      if (phase !== 'started') {
        sink.emit({ kind: 'status', payload: { status: 'plan', items: item.items } });
      }
      return null;
    case 'error':
      sink.emit({ kind: 'error', payload: { message: item.message, fatal: false } });
      return null;
    default:
      return null;
  }
}

export function createCodexRunner(deps: CodexRunnerDeps = {}): AgentRunner {
  return {
    id: 'codex',
    start(input: RunInput, sink: RunEventSink): RunHandle {
      const abort = new AbortController();
      let cancelled = false;

      const done = (async (): Promise<RunResult> => {
        const usage = emptyUsage();
        const counters = { toolCalls: 0 };
        let sessionId = input.resumeSessionId;
        let lastMessage = '';
        try {
          const factory = deps.factory ?? (await loadFactory());
          const { codex: codexOptions, thread: threadOptions } = buildCodexOptions(input, deps.env ?? process.env);
          const codex = factory(codexOptions);
          const thread = input.resumeSessionId ? codex.resumeThread(input.resumeSessionId, threadOptions) : codex.startThread(threadOptions);
          const prompt = input.contextPrefix ? `${input.contextPrefix}\n\n---\n\n${input.prompt}` : input.prompt;
          const { events } = await thread.runStreamed(input.resumeSessionId ? input.prompt : prompt, { signal: abort.signal });
          for await (const ev of events) {
            switch (ev.type) {
              case 'thread.started':
                sessionId = ev.thread_id;
                sink.setSessionId(ev.thread_id);
                sink.emit({ kind: 'status', payload: { status: 'started', detail: `Codex thread ${ev.thread_id} · sandbox ${input.sandbox}`, sessionId: ev.thread_id } });
                break;
              case 'item.started':
                itemEvents(ev.item, 'started', sink, counters);
                break;
              case 'item.updated':
                itemEvents(ev.item, 'updated', sink, counters);
                break;
              case 'item.completed': {
                const text = itemEvents(ev.item, 'completed', sink, counters);
                if (text) lastMessage = text;
                break;
              }
              case 'turn.completed':
                usage.inputTokens += ev.usage.input_tokens;
                usage.cachedTokens += ev.usage.cached_input_tokens;
                usage.outputTokens += ev.usage.output_tokens + ev.usage.reasoning_output_tokens;
                sink.emit({ kind: 'usage', payload: { ...usage, reasoningTokens: ev.usage.reasoning_output_tokens } });
                break;
              case 'turn.failed':
                sink.emit({ kind: 'error', payload: { message: ev.error.message } });
                return { status: 'failed', summary: ev.error.message, error: ev.error.message, sessionId, usage, toolCalls: counters.toolCalls };
              case 'error':
                sink.emit({ kind: 'error', payload: { message: ev.message } });
                return { status: 'failed', summary: ev.message, error: ev.message, sessionId, usage, toolCalls: counters.toolCalls };
              default:
                break;
            }
          }
          if (cancelled) return { status: 'cancelled', summary: 'Cancelled by you.', sessionId, usage, toolCalls: counters.toolCalls };
          return { status: 'done', summary: lastMessage.trim() || 'Finished.', sessionId: sessionId ?? thread.id ?? undefined, usage, toolCalls: counters.toolCalls };
        } catch (err) {
          if (cancelled || abort.signal.aborted) return { status: 'cancelled', summary: 'Cancelled by you.', sessionId, usage, toolCalls: counters.toolCalls };
          const message = err instanceof Error ? err.message : String(err);
          sink.emit({ kind: 'error', payload: { message } });
          return { status: 'failed', summary: message, error: message, sessionId, usage, toolCalls: counters.toolCalls };
        }
      })();

      return {
        done,
        async cancel() {
          cancelled = true;
          abort.abort();
        },
      };
    },
  };
}
