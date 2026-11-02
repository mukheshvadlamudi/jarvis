import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { RunnerRegistry } from '../runners/index.ts';
import type { RunEventSink } from '../runners/types.ts';
import { validateCron } from './service.ts';

const DAYS: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };

function parseTime(text: string): { h: number; m: number } | null {
  if (/\bnoon\b/.test(text)) return { h: 12, m: 0 };
  if (/\bmidnight\b/.test(text)) return { h: 0, m: 0 };
  const t = /\b(?:at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/.exec(text.replace(/\b(every|each)\s+\d+\s+(hours?|minutes?|mins?)\b/g, ''));
  if (!t) return null;
  let h = Number(t[1]);
  const m = Number(t[2] ?? 0);
  if (t[3] === 'pm' && h < 12) h += 12;
  if (t[3] === 'am' && h === 12) h = 0;
  if (h > 23 || m > 59) return null;
  return { h, m };
}

/** Rules for common phrasings — no agent call needed for these. Returns null if unsure. */
export function cronFromWordsLocal(input: string): string | null {
  const text = input.toLowerCase().replace(/,/g, ' ').replace(/\s+/g, ' ').trim();
  let m = /every (\d+) (minutes?|mins?)/.exec(text);
  if (m && Number(m[1]) >= 5 && Number(m[1]) < 60) return `*/${Number(m[1])} * * * *`;
  m = /every (\d+) hours?/.exec(text);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `0 */${Number(m[1])} * * *`;
  if (/^(every|each) hour$|^hourly$/.test(text)) return '0 * * * *';
  const time = parseTime(text);
  if (!time) return null;
  const hm = `${time.m} ${time.h}`;
  m = /(?:on the |the )?(\d{1,2})(?:st|nd|rd|th)?(?: day)? of (?:the|each|every) month/.exec(text) ?? /(?:monthly|every month) on the (\d{1,2})(?:st|nd|rd|th)?/.exec(text);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 31) return `${hm} ${Number(m[1])} * *`;
  if (/first (day )?of (the|each|every) month/.test(text)) return `${hm} 1 * *`;
  if (/weekday|work ?day|monday to friday|mon-fri/.test(text)) return `${hm} * * 1-5`;
  if (/weekend/.test(text)) return `${hm} * * 0,6`;
  const days = [...new Set((text.match(/\b(sun|sunday|mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)s?\b/g) ?? []).map((d) => DAYS[d.replace(/s$/, '')] ?? DAYS[d]))].filter((d) => d !== undefined);
  if (days.length) return `${hm} * * ${days.sort().join(',')}`;
  if (/every day|daily|each day|every morning|every evening|every night/.test(text)) return `${hm} * * *`;
  return null;
}

/**
 * Convert a description to cron. Local rules first; otherwise ONE small Codex call (only when the
 * owner presses the button). Always validated before returning.
 */
export async function cronFromWords(text: string, runners: RunnerRegistry, dataDir: string): Promise<{ cron: string | null; via: 'rules' | 'codex'; error?: string }> {
  const local = cronFromWordsLocal(text);
  if (local && !validateCron(local)) return { cron: local, via: 'rules' };
  const cwd = join(dataDir, 'workdirs', '_cron');
  mkdirSync(cwd, { recursive: true });
  const sink: RunEventSink = {
    emit: () => undefined,
    setSessionId: () => undefined,
    requestApproval: async () => ({ approved: false, status: 'rejected' }),
    rateLimit: () => undefined,
  };
  const handle = runners.get('codex').start(
    {
      taskId: 'cron',
      runId: 'cron',
      prompt: `[jarvis:cron] Convert this schedule to a standard 5-field cron expression (minute hour day-of-month month day-of-week, local time). Reply with ONLY the expression, nothing else.\nSchedule: ${text}`,
      contextPrefix: '',
      cwd,
      sandbox: 'read-only',
      allowNetwork: false,
      taskType: 'other',
    },
    sink,
  );
  const r = await handle.done;
  const cron = /((?:[\d*/,-]+\s+){4}[\d*/,-]+)/.exec(r.summary)?.[1]?.trim() ?? null;
  if (r.status !== 'done' || !cron) return { cron: null, via: 'codex', error: r.error ?? 'Could not understand that schedule. Try “weekdays at 8:30” or pick a preset.' };
  const invalid = validateCron(cron);
  return invalid ? { cron: null, via: 'codex', error: invalid } : { cron, via: 'codex' };
}
