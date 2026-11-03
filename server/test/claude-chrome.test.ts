import { describe, expect, it } from 'vitest';
import { buildClaudeOptions, createClaudeRunner } from '../src/runners/claude.ts';
import type { RunEventSink, RunInput } from '../src/runners/types.ts';

const input: RunInput = { taskId: 'test', runId: 'test', prompt: 'hello', contextPrefix: '', cwd: process.cwd(), sandbox: 'workspace-write', allowNetwork: true, taskType: 'other' };
const sink: RunEventSink = { emit: () => {}, setSessionId: () => {}, rateLimit: () => {}, requestApproval: async () => ({ approved: false, status: 'rejected' }) };

describe('Claude Chrome opt-in', () => {
  it('omits extraArgs when disabled or unspecified', () => {
    expect(buildClaudeOptions(input, sink, new AbortController(), {}).extraArgs).toBeUndefined();
    expect(buildClaudeOptions(input, sink, new AbortController(), {}, false).extraArgs).toBeUndefined();
  });
  it('passes the boolean CLI flag only when enabled', () => {
    expect(buildClaudeOptions(input, sink, new AbortController(), {}, true).extraArgs).toEqual({ chrome: null });
  });
  it('reads the current Chrome preference for every run (SDK mocked)', async () => {
    let enabled = true;
    const flags: unknown[] = [];
    const runner = createClaudeRunner({ chrome: () => enabled, queryFn: ({ options }) => {
      flags.push(options?.extraArgs);
      return (async function* () {})();
    } });
    await runner.start(input, sink).done;
    enabled = false;
    await runner.start(input, sink).done;
    expect(flags).toEqual([{ chrome: null }, undefined]);
  });
  it('requires Jarvis approval for browser mutations even when Chrome was enabled in the CLI itself', async () => {
    const options = buildClaudeOptions(input, sink, new AbortController(), {});
    const context = { signal: new AbortController().signal, toolUseID: 'test' } as Parameters<NonNullable<typeof options.canUseTool>>[2];
    for (const tool of ['computer', 'form_input', 'javascript_tool', 'browser_batch']) {
      const verdict = await options.canUseTool!(`mcp__claude-in-chrome__${tool}`, { action: 'left_click' }, context);
      expect(verdict?.behavior).toBe('deny');
    }
    const read = await options.canUseTool!('mcp__claude-in-chrome__read_page', {}, context);
    expect(read?.behavior).toBe('allow');
    const hook = options.hooks!.PreToolUse![0].hooks[0];
    expect(await hook({ hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-in-chrome__computer', tool_input: { action: 'key', text: 'Enter' }, tool_use_id: 'x', session_id: 's', transcript_path: '', cwd: input.cwd }, 'x', { signal: context.signal })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'ask' } });
  });
});
