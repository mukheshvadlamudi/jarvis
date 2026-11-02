const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function time(h: string, m: string): string | null {
  if (!/^\d+$/.test(h) || !/^\d+$/.test(m)) return null;
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

function days(dow: string): string | null {
  if (dow === '*') return null;
  if (dow === '1-5') return 'Weekdays';
  if (dow === '0,6' || dow === '6,0') return 'Weekends';
  const parts = dow.split(',');
  if (parts.every((p) => /^\d$/.test(p))) return parts.map((p) => DAY_NAMES[Number(p) % 7]).join(', ');
  return null;
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** Human description of a 5-field cron expression; falls back to the raw expression. */
export function describeCron(expr: string): string {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return expr;
  const [m, h, dom, mon, dow] = f;
  if (m === '0' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'Every hour';
  const everyH = /^\*\/(\d+)$/.exec(h);
  if (m === '0' && everyH && dom === '*' && mon === '*' && dow === '*') return `Every ${everyH[1]} hours`;
  const everyM = /^\*\/(\d+)$/.exec(m);
  if (everyM && h === '*' && dom === '*' && mon === '*' && dow === '*') return `Every ${everyM[1]} minutes`;
  const t = time(h, m);
  if (!t) return expr;
  if (dom === '*' && mon === '*') {
    const d = days(dow);
    if (dow === '*') return `Every day at ${t}`;
    if (d) return `${d} at ${t}`;
  }
  if (/^\d+$/.test(dom) && mon === '*' && dow === '*') return `Monthly on the ${ordinal(Number(dom))} at ${t}`;
  return expr;
}
