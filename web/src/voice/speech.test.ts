import { describe, expect, it } from 'vitest';
import { parseUtterance, stripWake } from './intents.ts';
import { answerToSpeech, sentences, toSpeech } from './speech.ts';

describe('speech text', () => {
  it('reads markdown naturally', () => {
    const s = toSpeech('# Result\n\n- Fixed **auth** bug ([PR](https://x.y/1)), 2 files (+49 −4)\n```ts\nconst a=1\n```\nBranch jarvis/t_3fq9k2m-token-refresh ready.');
    expect(s).toBe('Result. Fixed auth bug (PR), 2 files (plus 49 minus 4). (code omitted). Branch the Jarvis branch ready.');
    expect(toSpeech('word '.repeat(400), 100).endsWith('The rest is on screen.')).toBe(true);
  });
  it('reads only the opening three sentences of a chat answer', () => {
    expect(answerToSpeech('# Backups\n- **Daily** backups are ready.\n- Read [the guide](https://example.com).\n```ts\nconst secret = 1;\n```\nA fourth sentence stays on screen.')).toBe('Backups. Daily backups are ready. Read the guide.');
    expect(answerToSpeech('Use `backup.zip` today. It is ready! Is that enough? More detail.')).toBe('Use backup.zip today. It is ready! Is that enough?');
    expect(answerToSpeech('~~~ts\nconst a = 1;\n~~~')).toBe('');
    expect(answerToSpeech('')).toBe('');
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
  it('routes explicit asks and unmatched questions to conversations', () => {
    expect(parseUtterance('Jarvis, ask what did we decide about backups?', wake)).toEqual({ kind: 'conversation', text: 'what did we decide about backups?' });
    expect(parseUtterance('Jarvis, ask research backup tools', wake)).toEqual({ kind: 'conversation', text: 'research backup tools' });
    expect(parseUtterance('Jarvis, how do ClientEasy backups work?', wake)).toEqual({ kind: 'conversation', text: 'how do ClientEasy backups work?' });
    expect(parseUtterance('What about the weekly backup?', { ...wake, awaiting: true }).kind).toBe('conversation');
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
