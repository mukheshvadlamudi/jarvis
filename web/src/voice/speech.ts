/** Turn agent output (markdown, code, links) into something pleasant to listen to. */
export function toSpeech(text: string, maxChars = 700): string {
  let s = text
    .replace(/\bjarvis\/t_[a-z0-9]+-[\w-]+/gi, 'the Jarvis branch')
    .replace(/\bt_[a-z0-9]{6,}\b/g, '')
    .replace(/```[\s\S]*?```/g, ' (code omitted) ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/[*_~>|]+/g, '')
    .replace(/([+−-])(\d+)/g, (_, sign: string, n: string) => `${sign === '+' ? 'plus' : 'minus'} ${n}`)
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\.\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
    s = `${end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut} The rest is on screen.`;
  }
  return s;
}

/** Split into sentences so playback can start after the first one is synthesised. */
export function sentences(text: string): string[] {
  const parts = text.replace(/\s+/g, ' ').match(/[^.!?;]+[.!?;]*\s*/g) ?? [text];
  const out: string[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    // The first chunk stays short so audio starts quickly; later short bits merge for natural flow.
    if (out.length > 1 && (out[out.length - 1].length < 24 || t.length < 12)) out[out.length - 1] += ` ${t}`;
    else out.push(t);
  }
  // A long opening sentence is split at its first natural pause after a few words.
  if (out[0] && out[0].length > 60) {
    const m = /^(.{16,}?[,:\u2014–-])\s+(.+)$/.exec(out[0]);
    if (m) out.splice(0, 1, m[1], m[2]);
  }
  return out.length ? out : [text];
}

/** Read a short answer without speaking Markdown syntax, code blocks or link addresses. */
export function answerToSpeech(text: string): string {
  const plain = toSpeech(text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '').replace(/https?:\/\/\S+/g, ''), Number.MAX_SAFE_INTEGER);
  const first = (plain.match(/[\s\S]+?(?:[.!?]+(?=\s|$)|$)/g) ?? []).slice(0, 3).join(' ').replace(/\s+/g, ' ').trim();
  return toSpeech(first, 700);
}
