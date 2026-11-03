import { describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../../lib/live.ts';
import { VoiceTools } from './tools.ts';

function fixture() {
  let listener: (e: LiveEvent) => void = () => {};
  const unsubscribe = vi.fn(); const changed = vi.fn();
  const request = vi.fn(async (_path: string, _init?: unknown): Promise<any> => ({}));
  const tools = new VoiceTools('chat', changed, request, (fn) => { listener = fn; return unsubscribe; });
  return { tools, request, unsubscribe, changed, emit: (type: string, data: unknown) => listener({ type, data }) };
}
describe('voice tool bridge with fake requests and events', () => {
  it('runs a workflow by name and resolves its final spoken summary', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ workflows: [{ id: 'morning-brief', name: 'Morning brief', triggers: ['/brief'] }] })
      .mockResolvedValueOnce({ workflowRunId: 'wf', conversationId: 'chat' })
      .mockResolvedValue({ id: 'wf', status: 'running' });
    const pending = f.tools.handle('run_workflow', { workflow: 'Morning brief', input: '' });
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledWith('chat'));
    f.emit('workflow.updated', { id: 'other', status: 'done', summary: 'Wrong' });
    f.emit('workflow.updated', { id: 'wf', conversation_id: 'chat', status: 'done', summary: '**Your brief** is ready.' });
    expect(await pending).toMatchObject({ status: 'done', answer: 'Your brief is ready.' });
    expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('reconciles a fast workflow approval pause and lists user workflows', async () => {
    const f = fixture();
    f.request.mockResolvedValueOnce({ workflows: [{ id: 'ship-a-fix', name: 'Ship a fix', triggers: ['/fix'] }] })
      .mockResolvedValueOnce({ workflowRunId: 'wf', conversationId: 'chat' })
      .mockResolvedValueOnce({ id: 'wf', conversation_id: 'chat', status: 'waiting_approval', current_step: 0, definition: { steps: [{ kind: 'approval', summary: 'Push branch and open a PR?' }] } });
    expect(await f.tools.handle('run_workflow', { workflow: '/fix', input: 'Fix auth' })).toMatchObject({ status: 'waiting_approval', answer: 'Waiting for your OK: Push branch and open a PR?' });
    f.request.mockResolvedValue({ workflows: [{ id: 'custom', name: 'Custom routine', description: 'Mine', triggers: [], input: { label: 'Input', required: false }, private: 'hidden' }] });
    expect(await f.tools.handle('list_workflows')).toEqual({ workflows: [{ id: 'custom', name: 'Custom routine', description: 'Mine', triggers: [], input: { label: 'Input', required: false } }] });
  });
  it('waits for the exact agent run and strips Markdown from the first 1500 characters', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ runId: 'run1', conversation: { id: 'chat' } }).mockResolvedValue({ runs: [{ id: 'run1', status: 'running' }] });
    const result = f.tools.handle('ask_agent', { request: 'Research trends', agent: 'claude' });
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledWith('chat'));
    f.emit('run.finished', { id: 'other', agent: 'codex', status: 'done', answer: 'Wrong' });
    f.emit('run.finished', { id: 'run1', agent: 'claude', status: 'done', answer: '**Answer** [source](https://example.com) ' + 'x'.repeat(2000) });
    expect(await result).toMatchObject({ status: 'done', agent: 'claude' });
    const answer = (await result).answer as string; expect(answer).toHaveLength(1500); expect(answer).toMatch(/^Answer source/); expect(f.unsubscribe).toHaveBeenCalledOnce();
  });
  it('creates a conversation and reconciles a run that finished before the POST returned', async () => {
    const f = fixture(); f.tools.conversationId = null;
    f.request.mockResolvedValueOnce({ conversation: { id: 'new-chat' } }).mockResolvedValue({ runs: [{ id: 'r', agent: 'codex', status: 'done', answer: 'Finished early.' }] });
    const result = await f.tools.handle('ask_agent', { request: 'Check a file' });
    expect(f.request.mock.calls[0][0]).toBe('/api/conversations'); expect(f.changed).toHaveBeenCalledWith('new-chat'); expect(result.answer).toBe('Finished early.');
  });
  it('reconciles on SSE reconnect and reports agent failures', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ runId: 'r', conversation: { id: 'chat' } }).mockResolvedValueOnce({ runs: [{ id: 'r', status: 'running' }] });
    const pending = f.tools.handle('ask_agent', { request: 'Do work' });
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(2));
    f.request.mockResolvedValue({ runs: [{ id: 'r', agent: 'claude', status: 'failed', error: 'Sign in first' }] });
    f.emit('reconcile', {}); expect(await pending).toMatchObject({ status: 'failed', answer: 'Sign in first' });
  });
  it('get_status includes availability, current work and active runs', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ agents: { claude: { state: 'busy' }, codex: { state: 'ready' } } }).mockResolvedValueOnce({ runs: [{ id: 'r', agent: 'claude', status: 'running' }, { id: 'old', status: 'done' }] });
    expect(await f.tools.handle('get_status')).toEqual({ agents: [{ agent: 'claude', state: 'busy', detail: undefined, working_on: [] }, { agent: 'codex', state: 'ready', detail: undefined, working_on: [] }], active: [{ id: 'r', agent: 'claude' }] });
  });
  it('search_memory returns only five titles and bounded snippets', async () => {
    const f = fixture(); f.request.mockResolvedValue({ results: Array.from({ length: 8 }, () => ({ title: 'Note', snippet: 'x'.repeat(500), privateField: 'hidden' })) });
    const result = await f.tools.handle('search_memory', { query: 'hello & goodbye' });
    expect(f.request.mock.calls[0][0]).toContain('q=hello%20%26%20goodbye');
    expect((result.results as any[])).toHaveLength(5); expect((result.results as any[])[0]).toEqual({ title: 'Note', snippet: 'x'.repeat(350) });
  });
  it('remember saves through the existing note API', async () => {
    const f = fixture(); f.request.mockResolvedValue({ saved: 'Inbox.md' });
    expect(await f.tools.handle('remember', { text: 'Remember this' })).toEqual({ saved: 'Inbox.md' });
    expect(f.request).toHaveBeenCalledWith('/api/memory/remember', expect.objectContaining({ method: 'POST', body: { text: 'Remember this', source: 'Voice' } }));
  });
  it('stop_agent cancels only the active conversation', async () => {
    const f = fixture(); expect(await f.tools.handle('stop_agent')).toEqual({ status: 'cancelled' });
    expect(f.request).toHaveBeenCalledWith('/api/tasks/chat/cancel', expect.objectContaining({ method: 'POST' }));
    f.tools.conversationId = null; expect(await f.tools.handle('stop_agent')).toEqual({ status: 'idle' });
  });
  it('cleans subscriptions on cancellation and rejects malformed input', async () => {
    const f = fixture(); f.request.mockResolvedValue({ runId: 'r', conversation: { id: 'chat' }, runs: [] });
    const controller = new AbortController(); const pending = f.tools.handle('ask_agent', { request: 'Work' }, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow('cancelled'); expect(f.unsubscribe).toHaveBeenCalledOnce();
    await expect(f.tools.handle('ask_agent', { request: '' })).rejects.toThrow('Supply request');
    await expect(f.tools.handle('ask_agent', { request: 'work', agent: 'wrong' })).rejects.toThrow('Choose auto');
    await expect(f.tools.handle('unknown')).rejects.toThrow('Unknown voice tool');
  });
});

describe('usage and status for the voice brain', () => {
  it('get_usage reports real plan percentages, speakable reset times and voice minutes', async () => {
    const f = fixture();
    const inTwoHours = new Date(Date.now() + 2 * 3600_000 + 10 * 60_000).toISOString();
    f.request.mockImplementation(async (path: string) =>
      path === '/api/agents'
        ? { agents: { claude: { state: 'ready', usage: { five_hour: { usedPercent: 41.6, resetsAt: inTwoHours }, weekly: { usedPercent: 23, resetsAt: null } } }, codex: { state: 'ready', usage: { five_hour: null, weekly: null } } } }
        : { inSec: 300, outSec: 120 });
    const r = await f.tools.handle('get_usage', {});
    expect(r).toMatchObject({ claude: { five_hour: { used_percent: 42 }, weekly: { used_percent: 23, resets_in: 'unknown' } }, codex: { five_hour: 'not reported yet' }, voice_today_minutes: 7 });
    expect((r.claude as { five_hour: { resets_in: string } }).five_hour.resets_in).toMatch(/^in 2 hours (9|10) minutes$/);
  });

  it('get_status says what each agent is working on', async () => {
    const f = fixture();
    f.request.mockImplementation(async (path: string) =>
      path === '/api/agents'
        ? { agents: { claude: { state: 'busy', detail: 'Fix the login bug', busy: [{ title: 'Fix the login bug' }], usage: { five_hour: null, weekly: null } } } }
        : { runs: [] });
    expect(await f.tools.handle('get_status', {})).toMatchObject({ agents: [{ agent: 'claude', state: 'busy', working_on: ['Fix the login bug'] }] });
  });
});
