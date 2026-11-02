export type Intent =
  | { kind: 'ignore' }
  | { kind: 'wake' }
  | { kind: 'stop' }
  | { kind: 'repeat' }
  | { kind: 'approve' }
  | { kind: 'reject'; note?: string }
  | { kind: 'status' }
  | { kind: 'usage' }
  | { kind: 'result' }
  | { kind: 'cancel' }
  | { kind: 'mute' }
  | { kind: 'task'; text: string };

const WAKE = /^\s*(?:hey|ok|okay|hi|yo)?[\s,]*(?:jarvis|jarvis's|travis|jervis|javis)\b[\s,.!?:-]*/i;
const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

/** Remove a leading wake word; returns null when it is missing. */
export function stripWake(text: string): string | null {
  const m = WAKE.exec(text);
  return m ? text.slice(m[0].length).trim() : null;
}

/**
 * Map one utterance to an action. With `requireWake`, speech that doesn't start with "Jarvis" is
 * ignored (so TV, calls and other people don't create tasks) — unless a follow-up window is open.
 */
export function parseUtterance(raw: string, opts: { requireWake: boolean; awaiting: boolean }): Intent {
  const text = raw.trim();
  if (!text || /^\[?(blank_audio|music|silence|inaudible)\]?$/i.test(text) || text.replace(/[^\p{L}]/gu, '').length < 2) return { kind: 'ignore' };
  const stripped = stripWake(text);
  if (stripped === null && opts.requireWake && !opts.awaiting) return { kind: 'ignore' };
  const body = stripped ?? text;
  if (!body) return { kind: 'wake' };
  const c = clean(body);
  if (/^(stop|quiet|shut up|be quiet|that's enough|enough|cancel that|never mind|nevermind)$/.test(c)) return { kind: 'stop' };
  if (/^(repeat|say that again|what did you say|again)$/.test(c)) return { kind: 'repeat' };
  if (/^(mute|go to sleep|stop listening|sleep)$/.test(c)) return { kind: 'mute' };
  if (/^(yes )?(approve|approved|go ahead|do it|yes approve it|approve it|send it|ship it)$/.test(c)) return { kind: 'approve' };
  const rej = /^(reject|no|don't|do not|deny|decline)( it| that)?(?: because (.+))?$/.exec(c);
  if (rej) return { kind: 'reject', note: rej[3] };
  if (/^(status|what's running|what is running|what are you (doing|working on)|any updates|update me|what's going on)$/.test(c)) return { kind: 'status' };
  if (/^(usage|how much (usage|quota) (do i have|is left)|plan usage|limits?)$/.test(c)) return { kind: 'usage' };
  if (/^(read (it|the result|that)|what did it (say|find)|read me the (result|summary)|results?)$/.test(c)) return { kind: 'result' };
  if (/^(cancel|stop) (the |that |last )?(task|run)$/.test(c)) return { kind: 'cancel' };
  return { kind: 'task', text: body.replace(/^(please|can you|could you)\s+/i, '').replace(/[.?!]+$/, '') };
}
