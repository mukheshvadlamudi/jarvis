import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Safe Markdown renderer for agent answers and vault notes (React elements only — never raw HTML).
 * Headings, paragraphs, nested and task lists, quotes, fenced code with a language label, copy
 * button and light highlighting, tables with alignment, rules, and inline code, bold, italic,
 * strikethrough, links (nested formatting inside), bare URLs and Obsidian [[wikilinks]].
 */

type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: Array<{ text: string; checked?: boolean; depth?: number }>; start?: number }
  | { t: 'quote'; text: string }
  | { t: 'code'; lang: string; text: string }
  | { t: 'table'; head: string[]; rows: string[][]; align?: Align[] }
  | { t: 'hr' };

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out: Block[] = [];
  let i = 0;
  const isTableSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      const close = fence[1];
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) buf.push(lines[i++]);
      i++;
      out.push({ t: 'code', lang: fence[2], text: buf.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
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
      const seps = cells(lines[i + 1]);
      const align: Align[] = seps.map((s) => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null));
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(align.some(Boolean) ? { t: 'table', head, rows, align } : { t: 'table', head, rows });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', text: buf.join('\n') });
      continue;
    }
    const li = LIST.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items: Array<{ text: string; checked?: boolean; depth?: number }> = [];
      while (i < lines.length) {
        const m = LIST.exec(lines[i]);
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
        } else if (!lines[i].trim() && i + 1 < lines.length && LIST.exec(lines[i + 1]) && /\d/.test(LIST.exec(lines[i + 1])![2]) === ordered) {
          i++; // a blank line between items of the same list ("loose" lists) keeps the list together
        } else break;
      }
      const start = ordered ? Number.parseInt(li[2], 10) : 1;
      out.push(ordered && start !== 1 ? { t: 'ol', items, start } : { t: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,})|\s*>|\s*([-*+]|\d+[.)])\s)/.test(lines[i]) && !(lines[i].includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++]);
    out.push({ t: 'p', text: buf.join(' ') });
  }
  return out;
}

/** One inline token; the order is the precedence. */
const INLINE = new RegExp(
  [
    '(`+)([\\s\\S]+?)\\1', // 1,2 code
    '(\\[\\[[^\\]]+\\]\\])', // 3 wikilink
    '!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)', // 4,5 image (shown as a link: no remote loads)
    '\\[((?:[^\\[\\]]|\\[[^\\]]*\\])+)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)', // 6,7 link
    '(https?:\\/\\/[^\\s<>()]+[^\\s<>().,;:!?\'"])', // 8 bare url
    '\\*\\*([\\s\\S]+?)\\*\\*(?!\\*)', // 9 bold
    '(?<![\\w])__([\\s\\S]+?)__(?![\\w])', // 10 bold
    '~~([\\s\\S]+?)~~', // 11 strike
    '(?<![\\w*])\\*(?![\\s*])([\\s\\S]+?)(?<![\\s*])\\*(?![\\w*])', // 12 italic
    '(?<![\\w])_(?![\\s_])([\\s\\S]+?)(?<![\\s_])_(?![\\w])', // 13 italic
  ].join('|'),
  'g',
);

function safeHref(href: string): string | null {
  if (/^(https?:|mailto:)/i.test(href)) return href;
  if (/^[\w ./&-]+\.md$/i.test(href)) return `/memory?note=${encodeURIComponent(href)}`;
  return null;
}

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  const safe = safeHref(href);
  if (!safe) return <span>{children}</span>;
  return (
    <a href={safe} target={safe.startsWith('http') ? '_blank' : undefined} rel="noreferrer">
      {children}
    </a>
  );
}

export function inline(text: string, onWiki?: (target: string) => void): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index! > last) nodes.push(text.slice(last, m.index));
    if (m[2] !== undefined) nodes.push(<code key={k++}>{m[2].trim()}</code>);
    else if (m[3]) {
      const [target, alias] = m[3].slice(2, -2).split('|');
      nodes.push(
        <a
          key={k++}
          href={`/memory?note=${encodeURIComponent(target)}`}
          onClick={(e) => {
            if (onWiki) {
              e.preventDefault();
              onWiki(target);
            }
          }}
        >
          {alias ?? target}
        </a>,
      );
    } else if (m[5]) nodes.push(<Anchor key={k++} href={m[5]}>{m[4] || 'image'}</Anchor>);
    else if (m[7]) nodes.push(<Anchor key={k++} href={m[7]}>{inline(m[6], onWiki)}</Anchor>);
    else if (m[8]) nodes.push(<Anchor key={k++} href={m[8]}>{m[8].replace(/^https?:\/\/(www\.)?/, '')}</Anchor>);
    else if (m[9] !== undefined || m[10] !== undefined) nodes.push(<strong key={k++}>{inline(m[9] ?? m[10], onWiki)}</strong>);
    else if (m[11] !== undefined) nodes.push(<del key={k++}>{inline(m[11], onWiki)}</del>);
    else nodes.push(<em key={k++}>{inline(m[12] ?? m[13], onWiki)}</em>);
    last = m.index! + m[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Markdown to plain text for one-line summaries, notifications and speech. */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a: string, b: string) => b || a)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, '')
    .replace(/\|/g, ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Code blocks ------------------------------------------------------------------------------

const KEYWORDS = new Set(
  ('const let var function return if else for while do switch case break continue new class extends import from export default async await try catch finally throw typeof instanceof in of ' +
    'def elif lambda pass yield with as not and or is None True False self fn pub use mut impl struct enum match mod package func go defer chan interface type ' +
    'SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE JOIN ON GROUP BY ORDER LIMIT AND OR NOT NULL echo export sudo cd').split(' '),
);
const TOKEN = /(\/\/[^\n]*|#(?![!{])[^\n]*|--[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/g;
const HASH_COMMENT = /^(py|python|sh|bash|shell|zsh|ps1|powershell|yaml|yml|toml|rb|ruby|r|dockerfile|make|ini|conf)$/i;
const DASH_COMMENT = /^(sql|lua|hs|haskell)$/i;

/** Light, dependency-free highlighting: comments, strings, numbers and common keywords. */
function highlight(code: string, lang: string): ReactNode[] {
  if (/^(text|txt|plain|log|output|diff|md|markdown)?$/i.test(lang) && !/^(diff)$/i.test(lang)) return [code];
  if (/^diff$/i.test(lang)) {
    return code.split('\n').flatMap((l, i) => [
      i ? '\n' : '',
      <span key={i} className={l.startsWith('+') ? 'tok-add' : l.startsWith('-') ? 'tok-del' : l.startsWith('@@') ? 'tok-c' : undefined}>{l}</span>,
    ]);
  }
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of code.matchAll(TOKEN)) {
    const [tok, comment, str, num, word] = m;
    const isComment = !!comment && (comment.startsWith('#') ? HASH_COMMENT.test(lang) : comment.startsWith('--') ? DASH_COMMENT.test(lang) : true);
    if (comment && !isComment) continue;
    if (m.index! > last) out.push(code.slice(last, m.index));
    if (isComment) out.push(<span key={k++} className="tok-c">{tok}</span>);
    else if (str) out.push(<span key={k++} className="tok-s">{tok}</span>);
    else if (num) out.push(<span key={k++} className="tok-n">{tok}</span>);
    else if (word && KEYWORDS.has(word)) out.push(<span key={k++} className="tok-k">{tok}</span>);
    else out.push(tok);
    last = m.index! + tok.length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span className="code-lang">{lang || 'text'}</span>
        <button
          type="button"
          className="code-copy"
          aria-label="Copy code"
          onClick={() =>
            void navigator.clipboard?.writeText(text).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={13} strokeWidth={1.5} /> : <Copy size={13} strokeWidth={1.5} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{highlight(text, lang)}</code>
      </pre>
    </div>
  );
}

export function Markdown({ source, onWiki }: { source: string; onWiki?: (target: string) => void }) {
  const blocks = parseBlocks(source);
  return (
    <div className="prose">
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = `h${Math.min(b.level, 4)}` as 'h1' | 'h2' | 'h3' | 'h4';
            return <Tag key={i}>{inline(b.text, onWiki)}</Tag>;
          }
          case 'p':
            return <p key={i}>{inline(b.text, onWiki)}</p>;
          case 'ul':
          case 'ol': {
            const Tag = b.t;
            return (
              <Tag key={i} start={b.t === 'ol' ? b.start : undefined}>
                {b.items.map((it, j) => (
                  <li key={j} className={it.checked !== undefined ? 'task' : undefined} style={it.depth ? { marginLeft: it.depth * 18, listStyleType: b.t === 'ul' ? 'circle' : undefined } : undefined}>
                    {it.checked !== undefined ? <input type="checkbox" checked={it.checked} readOnly aria-label={it.checked ? 'done' : 'not done'} /> : null}
                    {inline(it.text, onWiki)}
                  </li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={i}>
                {b.text.split(/\n{2,}/).map((para, j) => (
                  <p key={j}>{inline(para.replace(/\n/g, ' '), onWiki)}</p>
                ))}
              </blockquote>
            );
          case 'code':
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case 'table':
            return (
              <div key={i} className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} style={b.align?.[j] ? { textAlign: b.align[j]! } : undefined}>{inline(h, onWiki)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, x) => (
                          <td key={x} style={b.align?.[x] ? { textAlign: b.align[x]! } : undefined}>{inline(c, onWiki)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
