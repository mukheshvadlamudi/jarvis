import { describe, expect, it } from 'vitest';
import { isNoise, parseUtterance, stripWake } from './intents.ts';

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
