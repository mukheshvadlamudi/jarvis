import { relative } from 'node:path';
import type { Attachment } from '../types.ts';

/** Message-size limits: larger files are still available to the agent in ./attachments. */
const IMAGE_MAX = 5 * 1024 * 1024;
const PDF_MAX = 20 * 1024 * 1024;
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** How an attachment can go into the message itself for this agent, if at all. */
export function inlineKind(a: Attachment, agent: 'claude' | 'codex'): 'image' | 'pdf' | null {
  if (IMAGE_MIME.has(a.mime) && a.size <= IMAGE_MAX) return 'image';
  if (agent === 'claude' && a.mime === 'application/pdf' && a.size <= PDF_MAX) return 'pdf';
  return null;
}

/** Appended to the prompt so the agent knows every attached file and where to open it. */
export function attachmentNote(list: Attachment[] | undefined, cwd?: string): string {
  if (!list?.length) return '';
  const lines = list.map((a) => {
    const where = cwd ? relative(cwd, a.path).replace(/\\/g, '/') : a.path;
    return `- ${a.name} (${a.mime}, ${Math.max(1, Math.round(a.size / 1024))} KB) at ${where}`;
  });
  return `\n\nAttached files (open them with your file tools when you need their contents):\n${lines.join('\n')}`;
}
