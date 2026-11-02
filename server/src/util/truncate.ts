export const MAX_PAYLOAD_BYTES = 20 * 1024;

/**
 * Cap a stored string at ~20 KB. Long values keep the head and tail so errors at the end of
 * logs stay visible, and carry an explicit note that truncation happened.
 */
export function truncateText(text: string, max = MAX_PAYLOAD_BYTES): { text: string; truncated: boolean; originalBytes: number } {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= max) return { text, truncated: false, originalBytes: bytes };
  const head = Math.floor(max * 0.7);
  const tail = max - head - 200;
  const note = `\n\n[… truncated by Jarvis: ${bytes.toLocaleString('en-US')} bytes total, showing first ${head} and last ${tail} …]\n\n`;
  return { text: text.slice(0, head) + note + text.slice(-tail), truncated: true, originalBytes: bytes };
}

/** Truncate every long string field of an event payload in place-safe fashion. */
export function capPayload(payload: Record<string, unknown>, max = MAX_PAYLOAD_BYTES): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let truncated = false;
  for (const [k, v] of Object.entries(payload)) {
    if (typeof v === 'string') {
      const t = truncateText(v, max);
      out[k] = t.text;
      if (t.truncated) truncated = true;
    } else if (v !== null && typeof v === 'object') {
      const json = JSON.stringify(v);
      if (json !== undefined && Buffer.byteLength(json, 'utf8') > max) {
        out[k] = truncateText(json, max).text;
        truncated = true;
      } else {
        out[k] = v;
      }
    } else {
      out[k] = v;
    }
  }
  if (truncated) out.truncated = true;
  return out;
}
