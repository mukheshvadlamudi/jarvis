import { describe, expect, it } from 'vitest';
import type { ConversationRun } from './ask.ts';
import { askedText, conversationTurns, runPurpose, runVisibility, sideLabel } from './ask.ts';

const run = (id: string, extra: Record<string, unknown> = {}) => ({ id, started_at: `2026-11-03T10:00:0${id.length}Z`, agent: 'codex', route_reason: null, prompt: 'History\nNew message from the owner:\nActual message', events: [], ...extra }) as unknown as ConversationRun;

describe('conversation projection', () => {
  it('uses exactly the owner text, including empty text, instead of the executable prompt', () => {
    expect(askedText(run('a', { owner_text: '  Owner wrote this\n' }))).toBe('  Owner wrote this\n');
    expect(askedText(run('a', { owner_text: '' }))).toBe('');
    expect(askedText(run('a'))).toBe('Actual message');
  });
  it('only infers legacy prefixes when purpose is null', () => {
    for (const [reason, purpose] of [['side:both:old label', 'both'], ['side:second opinion:old label', 'second_opinion'], ['consult:codex', 'consult'], ['learning skill', 'learning']]) expect(runPurpose(run('r', { route_reason: reason }))).toBe(purpose);
    expect(runPurpose(run('r', { purpose: 'user_reply', route_reason: 'learning' }))).toBe('user_reply');
    expect(runVisibility(run('r', { purpose: 'verify' }))).toBe('internal');
    expect(runVisibility(run('r', { purpose: 'maintenance' }))).toBe('internal');
    expect(runVisibility(run('r', { purpose: 'consult' }))).toBe('activity');
    expect(sideLabel(run('r', { purpose: 'second_opinion' }))?.text).toBe("Codex's second opinion");
  });
  it('hides internal runs and groups consults and side answers with explicit parents', () => {
    const first = run('a'); const second = run('bb');
    const consult = run('ccc', { purpose: 'consult', visibility: 'activity', parent_run_id: 'a' });
    const side = run('dddd', { purpose: 'both', parent_run_id: 'a' });
    const hidden = run('eeeee', { purpose: 'learning', visibility: 'internal' });
    expect(conversationTurns([first, second, consult, side, hidden])).toEqual([{ run: first, consults: [consult], sides: [side] }, { run: second, consults: [], sides: [] }]);
  });
  it('attaches legacy side runs to the preceding owner turn and never shows orphan consult prompts', () => {
    const first = run('a'); const side = run('bb', { route_reason: 'side:both:raw label' });
    expect(conversationTurns([first, side])[0].sides).toEqual([side]);
    expect(conversationTurns([run('a', { purpose: 'consult', parent_run_id: 'missing' })])).toEqual([]);
  });
});
