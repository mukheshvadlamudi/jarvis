import type { ReactNode } from 'react';

/**
 * Small, safe Markdown renderer for vault notes (React elements only — never raw HTML).
 * Supports headings, paragraphs, lists (incl. tasks), quotes, code fences, tables, rules,
 * inline code/bold/italic/links and Obsidian [[wikilinks]].
 */

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: Array<{ text: string; checked?: boolean; depth?: number }> }
  | { t: 'quote'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' };

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang: fence[1], text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ t: 'quote', text: buf.join(' ') });
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: Array<{ text: string; checked?: boolean; depth?: number }> = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          const task = /^\[( |x|X)\]\s+(.*)$/.exec(m[3]);
          const depth = Math.min(3, Math.floor(m[1].replace(/\t/g, '  ').length / 2));
          const item: { text: string; checked?: boolean; depth?: number } = task ? { text: task[2], checked: task[1] !== ' ' } : { text: m[3] };
          if (depth) item.depth = depth;
          items.push(item);
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`;
          i++;
        } else break;
      }
      out.push({ t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|>|\s*([-*+]|\d+[.)])\s)/.test(lines[i])) buf.push(lines[i++]);
    out.push({ t: 'p', text: buf.join(' ') });
  }
  return out;
}

const INLINE = /(`[^`]+`)|(\[\[[^\]]+\]\])|(\[[^\]]+\]\([^)\s]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\s][^*]*\*)|(_[^_\s][^_]*_)/g;

function safeHref(href: string): string | null {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[\w ./&-]+\.md$/i.test(href)) return `/memory?note=${encodeURIComponent(href)}`;
  return null;
}

export function inline(text: string, onWiki?: (target: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (m[1]) nodes.push(<code key={k++}>{tok.slice(1, -1)}</code>);
    else if (m[2]) {
      const [target, alias] = tok.slice(2, -2).split('|');
      nodes.push(
        <a key={k++} href={`/memory?note=${encodeURIComponent(target)}`} onClick={(e) => {
          if (onWiki) {
            e.preventDefault();
            onWiki(target);
          }
        }}>
          {alias ?? target}
        </a>,
      );
    } else if (m[3]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok)!;
      const href = safeHref(lm[2]);
      nodes.push(href ? <a key={k++} href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noreferrer">{lm[1]}</a> : <span key={k++}>{lm[1]}</span>);
    } else if (m[4] || m[5]) nodes.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else nodes.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = m.index! + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source, onWiki }: { source: string; onWiki?: (target: string) => void }) {
  const blocks = parseBlocks(source);
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = (`h${Math.min(b.level, 3)}` as 'h1' | 'h2' | 'h3');
            return <Tag key={i}>{inline(b.text, onWiki)}</Tag>;
          }
          case 'p':
            return <p key={i}>{inline(b.text, onWiki)}</p>;
          case 'ul':
          case 'ol': {
            const Tag = b.t;
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j} style={{ ...(it.checked !== undefined ? { listStyle: 'none', marginLeft: -18 } : {}), ...(it.depth ? { marginLeft: it.depth * 18, listStyleType: 'circle' } : {}) }}>
                    {it.checked !== undefined ? <input type="checkbox" checked={it.checked} readOnly aria-label={it.checked ? 'done' : 'not done'} style={{ marginRight: 8, accentColor: 'var(--primary)' }} /> : null}
                    {inline(it.text, onWiki)}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return <blockquote key={i}>{inline(b.text, onWiki)}</blockquote>;
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case 'table':
            return (
              <table key={i}>
                <thead>
                  <tr>{b.head.map((h, j) => <th key={j}>{inline(h, onWiki)}</th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>{r.map((c, x) => <td key={x}>{inline(c, onWiki)}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            );
          case 'hr':
            return <hr key={i} />;
        }
      })}
    </div>
  );
}

/** Split a search snippet with \u0001…\u0002 highlight markers. */
export function Highlight({ text }: { text: string }) {
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0001') ? (
          <mark key={i} style={{ background: 'var(--accent-soft)', color: 'var(--accent-text)', borderRadius: 2, padding: '0 1px' }}>
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
