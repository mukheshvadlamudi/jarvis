export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  const future = diff > 0;
  const m = Math.round(abs / 60000);
  let s: string;
  if (abs < 45_000) return future ? 'in a moment' : 'just now';
  if (m < 60) s = `${m}m`;
  else if (m < 60 * 24) s = `${Math.floor(m / 60)}h${m % 60 && m < 600 ? ` ${m % 60}m` : ''}`;
  else if (m < 60 * 24 * 14) s = `${Math.round(m / 1440)}d`;
  else return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return future ? `in ${s}` : `${s} ago`;
}

export function shortAge(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  return `${Math.floor(m / 1440)}d`;
}

export function resetsIn(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'reset time unknown';
  const ms = Date.parse(iso) - now;
  if (ms <= 0) return 'resetting';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `resets in ${d}d ${h}h`;
  if (h > 0) return `resets in ${h}h ${mm}m`;
  return `resets in ${mm}m`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function clock(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function duration(fromIso: string, toIso: string | null, now = Date.now()): string {
  const ms = (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const STATUS_LABEL: Record<string, string> = {
  inbox: 'Inbox',
  queued: 'Queued',
  running: 'Running',
  needs_you: 'Needs you',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const TYPE_LABEL: Record<string, string> = {
  code: 'Code',
  research: 'Research',
  write: 'Writing',
  admin: 'Admin',
  update: 'Updates',
  memory: 'Memory',
  other: 'Other',
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
