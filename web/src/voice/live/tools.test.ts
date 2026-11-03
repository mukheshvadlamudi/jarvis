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
  it('get_status includes availability and active runs only', async () => {
    const f = fixture(); f.request.mockResolvedValueOnce({ agents: { claude: { state: 'busy' }, codex: { state: 'ready' } } }).mockResolvedValueOnce({ runs: [{ id: 'r', agent: 'claude', status: 'running' }, { id: 'old', status: 'done' }] });
    expect(await f.tools.handle('get_status')).toEqual({ agents: [{ agent: 'claude', state: 'busy' }, { agent: 'codex', state: 'ready' }], active: [{ id: 'r', agent: 'claude' }] });
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
