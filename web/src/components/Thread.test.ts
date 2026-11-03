import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRun } from '../lib/ask.ts';
import { digest, Turn } from './Thread.tsx';

vi.mock('../lib/router.ts', () => ({ linkHandler: () => () => undefined }));

const run = (extra: Record<string, unknown> = {}) => ({ id: 'r1', agent: 'claude', status: 'running', started_at: '2026-11-03T00:00:00Z', ended_at: null, prompt: 'Actual message', events: [], ...extra }) as unknown as ConversationRun;
const event = (id: number, kind: string, payload: Record<string, unknown>) => ({ id, run_id: 'r1', kind, payload });
const render = (r: ConversationRun, consults: ConversationRun[] = []) => renderToStaticMarkup(createElement(Turn, { run: r, consults, approvals: [], conversationId: 'c1', last: true, now: Date.parse('2026-11-03T00:01:00Z'), onAskOther: () => undefined, onDecided: () => undefined }));
describe('Ask turns', () => {
  it('only a matching result or error ends a tool step', () => {
    const events = [event(1, 'tool_call', { id: 'one', tool: 'Read' }), event(2, 'tool_call', { id: 'two', tool: 'Read' }), event(3, 'tool_result', { id: 'two' })];
    expect(digest(run({ events })).steps.map((s) => s.state)).toEqual(['running', 'done']);
    expect(digest(run({ status: 'done', events })).steps[0].state).toBe('running');
    events.push(event(4, 'error', { id: 'one', message: 'Read failed' }));
    expect(digest(run({ events })).steps[0].state).toBe('error');
  });
  it('hides internal/activity turns, consult prompts and routing, while showing owner text', () => {
    expect(render(run({ visibility: 'internal' }))).toBe('');
    expect(render(run({ purpose: 'consult' }))).toBe('');
    const html = render(run({ owner_text: 'My actual words', route_reason: 'private route', model: 'chosen model', effort: 'high' }));
    expect(html).toContain('My actual words'); expect(html).not.toContain('>private route<'); expect(html).not.toContain('>high effort<');
    const consult = run({ id: 'consult', agent: 'codex', purpose: 'consult', answer: 'A useful finding. More detail.', prompt: 'SECRET CONSULT PROMPT' });
    const activity = render(run(), [consult]);
    expect(activity).toContain('Asked Codex for a second opinion'); expect(activity).toContain('A useful finding.'); expect(activity).not.toContain('SECRET CONSULT PROMPT');
  });
  it('collapses completed work by default and uses the final stored answer', () => {
    const html = render(run({ status: 'done', answer: 'Final answer', events: [event(1, 'message', { role: 'reasoning', text: 'PRIVATE REASONING' })] }));
    expect(html).toContain('aria-expanded="false"'); expect(html).toContain('Final answer'); expect(html).not.toContain('PRIVATE REASONING');
  });
});
