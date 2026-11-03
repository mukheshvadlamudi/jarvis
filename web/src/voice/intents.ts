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
  | { kind: 'task'; text: string }
  | { kind: 'conversation'; text: string; fresh?: boolean };

const WAKE = /^(?:(?:hey|ok|okay|so|um|uh|hi|yo|please)\b[\s\p{P}\p{S}]*){0,3}(?:jarvis(?:'s)?|jervis|javis|jarvas|jarviss|jarvi|travis|charvis|jarbis|jarves|jar[\s\p{P}]+vis)\b[\s\p{P}\p{S}]*/iu;
const clean = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim();

export function isNoise(text: string): boolean {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return !words || /^(you|thank you|blank audio|music|silence|inaudible)$/.test(words) || text.replace(/[^\p{L}]/gu, '').length < 2;
}

/**
 * True when what the mic heard is Jarvis's own voice coming back from the speakers: no wake word,
 * and at least 60% of its words appear in the line Jarvis is saying.
 */
export function isEcho(text: string, said: string): boolean {
  if (!said.trim() || stripWake(text) !== null) return false;
  const words = clean(text).split(' ').filter(Boolean);
  if (!words.length) return false;
  const spoken = new Set(clean(said).split(' '));
  return words.filter((w) => spoken.has(w)).length / words.length >= 0.6;
}

/** A wake word may follow up to three fillers; preserve the command verbatim. */
export function stripWake(text: string): string | null {
  const input = text.replace(/^[\s\p{P}\p{S}]+/u, '');
  const m = WAKE.exec(input);
  return m ? input.slice(m[0].length).trim() : null;
}

/**
 * Map one utterance to an action. With `requireWake`, speech that doesn't start with "Jarvis" is
 * ignored (so TV, calls and other people don't create tasks) — unless a follow-up window is open.
 */
export function parseUtterance(raw: string, opts: { requireWake: boolean; awaiting: boolean }): Intent {
  const text = raw.trim();
  if (isNoise(text)) return { kind: 'ignore' };
  const stripped = stripWake(text);
  if (stripped === null && opts.requireWake && !opts.awaiting) return { kind: 'ignore' };
  const body = stripped ?? text;
  if (!body) return { kind: 'wake' };
  if (isNoise(body)) return { kind: 'ignore' };
  const fresh = /^new conversation(?:[,:]\s*|\s+)?([\s\S]*)$/i.exec(body);
  if (fresh) return { kind: 'conversation', text: fresh[1].trim().replace(/^[.!?]+$/, ''), fresh: true };
  const ask = /^ask\s+([\s\S]+)/i.exec(body);
  if (ask) return { kind: 'conversation', text: ask[1].trim() };
  const c = clean(body);
  if (/^(stop|stop speaking|stop speech|quiet|shut up|be quiet|that's enough|enough|cancel that|never mind|nevermind)$/.test(c)) return { kind: 'stop' };
  if (/^(repeat|say that again|what did you say|again)$/.test(c)) return { kind: 'repeat' };
  if (/^(mute|mute mic|mute microphone|go to sleep|stop listening|sleep)$/.test(c)) return { kind: 'mute' };
  if (/^(yes )?(approve|approved|go ahead|do it|yes approve it|approve it|send it|ship it)$/.test(c)) return { kind: 'approve' };
  const rej = /^(reject|no|don't|do not|deny|decline)( it| that)?(?: because (.+))?$/.exec(c);
  if (rej) return { kind: 'reject', note: rej[3] };
  if (/^(status|what's running|what is running|what are you (doing|working on)|any updates|update me|what's going on)$/.test(c)) return { kind: 'status' };
  if (/^(usage|how much (usage|quota) (do i have|is left)|plan usage|limits?)$/.test(c)) return { kind: 'usage' };
  if (/^(read (it|the result|that)|what did it (say|find)|read me the (result|summary)|results?)$/.test(c)) return { kind: 'result' };
  if (/^(cancel|stop) (the |that |last )?(task|run|agent)$/.test(c)) return { kind: 'cancel' };
  const request = body.replace(/^(please|can you|could you)\s+/i, '');
  const task = /^(research|draft|write|build|create|fix|implement|schedule|send|run|review|update|delete|remind)\b/i.test(request);
  return { kind: task ? 'task' : 'conversation', text: task ? request.replace(/[.?!]+$/, '') : body };
}
