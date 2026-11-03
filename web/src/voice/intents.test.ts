import { describe, expect, it } from 'vitest';
import { isEcho, isNoise, parseUtterance, stripWake } from './intents.ts';

const wake = { requireWake: true, awaiting: false };

describe('wake word recognition', () => {
  it.each(['jarvis', 'jervis', 'javis', 'jarvas', 'jarviss', 'jarvi', 'travis', 'charvis', 'jarbis', 'jarves', 'jar vis'])('accepts Whisper spelling %s', (name) => {
    expect(parseUtterance(`“${name}!” Research backup tools.`, wake)).toEqual({ kind: 'task', text: 'Research backup tools' });
  });

  it.each(['hey', 'ok', 'okay', 'so', 'um', 'uh', 'hi', 'yo', 'please', 'okay so', 'um okay so', 'hey,'])('accepts fillers: %s', (filler) => {
    expect(stripWake(`${filler} Jarvis, ask How are backups stored?`)).toBe('ask How are backups stored?');
  });

  it.each(['hey okay so please Jarvis status', 'ask Jarvis about backups', 'Jarvision status', 'research Travis County'])('does not activate on %s', (text) => {
    expect(stripWake(text)).toBeNull();
    expect(parseUtterance(text, wake)).toEqual({ kind: 'ignore' });
  });

  it.each(['', 'you', 'thank you.', '[BLANK_AUDIO]', '(silence)', '[music]', '!!!', 'a'])('treats %s as noise even with wake disabled', (text) => {
    expect(isNoise(text)).toBe(true);
    expect(parseUtterance(text, { requireWake: false, awaiting: true })).toEqual({ kind: 'ignore' });
  });

  it('preserves real requests and wake-only prompts', () => {
    expect(parseUtterance('okay so Jarvis!', wake)).toEqual({ kind: 'wake' });
    expect(parseUtterance('thank you for checking backups', { requireWake: false, awaiting: false })).toEqual({ kind: 'conversation', text: 'thank you for checking backups' });
  });
});

describe('echo rejection', () => {
  const said = 'Done: Backups. Your backups run daily at two in the morning.';
  it('drops Jarvis hearing its own line', () => {
    expect(isEcho('your backups run daily', said)).toBe(true);
    expect(isEcho('Backups run daily at two in the', said)).toBe(true);
  });
  it('keeps real speech, wake words, and anything when nothing was said', () => {
    expect(isEcho('stop', said)).toBe(false);
    expect(isEcho('what time is the meeting', said)).toBe(false);
    expect(isEcho('Jarvis, backups run daily', said)).toBe(false);
    expect(isEcho('backups run daily', '')).toBe(false);
  });
});

it('distinguishes speech, agent and microphone commands and a fresh conversation', () => {
  const options = { requireWake: true, awaiting: false };
  expect(parseUtterance('Jarvis stop speaking', options)).toEqual({ kind: 'stop' });
  expect(parseUtterance('Jarvis stop agent', options)).toEqual({ kind: 'cancel' });
  expect(parseUtterance('Jarvis mute microphone', options)).toEqual({ kind: 'mute' });
  expect(parseUtterance('Jarvis new conversation.', options)).toEqual({ kind: 'conversation', text: '', fresh: true });
  expect(parseUtterance('Jarvis new conversation: plan tomorrow', options)).toEqual({ kind: 'conversation', text: 'plan tomorrow', fresh: true });
});
