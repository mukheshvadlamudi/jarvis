import { describe, expect, it } from 'vitest';
import { relTime, resetsIn, shortAge, tokens } from './format.ts';

const now = Date.parse('2026-11-02T12:00:00Z');

describe('format', () => {
  it('formats relative times', () => {
    expect(relTime('2026-11-02T11:59:50Z', now)).toBe('just now');
    expect(relTime('2026-11-02T11:15:00Z', now)).toBe('45m ago');
    expect(relTime('2026-11-02T09:30:00Z', now)).toBe('2h 30m ago');
    expect(relTime('2026-11-02T14:00:00Z', now)).toBe('in 2h');
    expect(relTime('2026-10-30T12:00:00Z', now)).toBe('3d ago');
  });
  it('formats resets and ages', () => {
    expect(resetsIn('2026-11-02T14:14:00Z', now)).toBe('resets in 2h 14m');
    expect(resetsIn('2026-11-04T15:00:00Z', now)).toBe('resets in 2d 3h');
    expect(resetsIn(null, now)).toBe('reset time unknown');
    expect(shortAge('2026-11-01T12:00:00Z', now)).toBe('1d');
  });
  it('formats token counts', () => {
    expect(tokens(950)).toBe('950');
    expect(tokens(1250)).toBe('1.3k');
    expect(tokens(84120)).toBe('84k');
    expect(tokens(2_400_000)).toBe('2.4M');
  });
});
