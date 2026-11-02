import { describe, expect, it } from 'vitest';
import { describeCron } from './cron.ts';

describe('describeCron', () => {
  it('describes common schedules', () => {
    expect(describeCron('0 8 * * 1-5')).toBe('Weekdays at 08:00');
    expect(describeCron('30 7 * * *')).toBe('Every day at 07:30');
    expect(describeCron('0 16 * * 5')).toBe('Fri at 16:00');
    expect(describeCron('15 10 * * 1,4')).toBe('Mon, Thu at 10:15');
    expect(describeCron('0 */4 * * *')).toBe('Every 4 hours');
    expect(describeCron('0 9 1 * *')).toBe('Monthly on the 1st at 09:00');
    expect(describeCron('0 9 22 * *')).toBe('Monthly on the 22nd at 09:00');
    expect(describeCron('5 4 * 2 *')).toBe('5 4 * 2 *');
  });
});
