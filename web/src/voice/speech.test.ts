import { describe, expect, it } from 'vitest';
import { parseUtterance, stripWake } from './intents.ts';
import { sentences, toSpeech } from './speech.ts';

describe('speech text', () => {
  it('reads markdown naturally', () => {
    const s = toSpeech('# Result\n\n- Fixed **auth** bug ([PR](https://x.y/1)), 2 files (+49 −4)\n```ts\nconst a=1\n```\nBranch jarvis/t_3fq9k2m-token-refresh ready.');
    expect(s).toBe('Result. Fixed auth bug (PR), 2 files (plus 49 minus 4). (code omitted). Branch the Jarvis branch ready.');
    expect(toSpeech('word '.repeat(400), 100).endsWith('The rest is on screen.')).toBe(true);
  });
  it('keeps the first chunk short for fast start, merges tiny fragments after it', () => {
    expect(sentences('Done. All 128 tests pass. Branch is ready for review!')).toEqual(['Done.', 'All 128 tests pass. Branch is ready for review!']);
    const long = sentences('The migration finished on all three databases, and the slow query on orders now takes forty milliseconds instead of two seconds. Nothing else changed.');
    expect(long[0]).toBe('The migration finished on all three databases,');
    expect(long.length).toBe(3);
  });
});

describe('voice intents', () => {
  const wake = { requireWake: true, awaiting: false };
  it('requires the wake word unless a follow-up window is open', () => {
    expect(parseUtterance('research backup tools', wake)).toEqual({ kind: 'ignore' });
    expect(parseUtterance('Hey Jarvis, research the best Postgres backup tools.', wake)).toEqual({ kind: 'task', text: 'research the best Postgres backup tools' });
    expect(parseUtterance('Jarvis', wake)).toEqual({ kind: 'wake' });
    expect(parseUtterance('approve', { requireWake: true, awaiting: true })).toEqual({ kind: 'approve' });
    expect(stripWake('Travis, status')).toBe('status');
  });
  it('understands commands', () => {
    const open = { requireWake: false, awaiting: false };
    expect(parseUtterance('Stop.', open).kind).toBe('stop');
    expect(parseUtterance("What's running?", open).kind).toBe('status');
    expect(parseUtterance('reject because the tone is off', open)).toEqual({ kind: 'reject', note: 'the tone is off' });
    expect(parseUtterance('read the result', open).kind).toBe('result');
    expect(parseUtterance('[BLANK_AUDIO]', open).kind).toBe('ignore');
    expect(parseUtterance('Could you draft a reply to Sam about the launch date?', open)).toEqual({ kind: 'task', text: 'draft a reply to Sam about the launch date' });
  });
});
