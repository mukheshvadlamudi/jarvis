import { lazy, Suspense } from 'react';
import type { Components } from 'streamdown';
import { Streamdown } from 'streamdown';
import { Markdown } from './markdown.tsx';

const Diagram = lazy(() => import('../components/ask/Diagram.tsx'));

export function answerHref(url: string): string | undefined {
  if (/[\u0000-\u0020\\]/.test(url)) return undefined;
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  if (/^\/(?!\/)/.test(url) || url.startsWith('#')) return url;
  return undefined;
}

function vaultLinks(source: string) {
  return source.replace(/(`{3,}[\s\S]*?(?:`{3,}|$)|~{3,}[\s\S]*?(?:~{3,}|$)|`+[^`]*`+)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (match, code: string, path: string, alias: string) => code ? match : `[${alias || path}](/memory?note=${encodeURIComponent(path)})`);
}

const components: Components = {
  strong: ({ children }) => <strong>{children}</strong>,
  a: ({ href, children }) => { const safe = answerHref(href ?? ''); return safe ? <a href={safe} target={safe.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">{children}</a> : <span>{children}</span>; },
  img: ({ alt }) => <span className="muted">{alt ? `Image: ${alt}` : 'Image omitted'}</span>,
  pre: ({ children }) => <>{children}</>,
  code: ({ children, className, node }) => {
    const lang = /language-([^\s]+)/.exec(className ?? '')?.[1] ?? '';
    const text = String(children ?? '').replace(/\n$/, '');
    const block = !!lang || text.includes('\n') || node?.position?.start.line !== node?.position?.end.line;
    if (!block) return <code>{children}</code>;
    if (lang === 'mermaid') return <Suspense fallback={<p className="muted">Loading diagram…</p>}><Diagram source={text} /></Suspense>;
    return <Markdown source={`\`\`\`\` ${lang}\n${text}\n\`\`\`\``} />;
  },
  table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
};

/** Streamdown handles partial Markdown; code keeps the vault renderer's copy and highlighting. */
export function Answer({ source, streaming = false }: { source: string; streaming?: boolean }) {
  return <Streamdown mode={streaming ? 'streaming' : 'static'} isAnimating={streaming} components={components} controls={false} skipHtml urlTransform={(url) => answerHref(url) ?? ''} className="answer-markdown">{vaultLinks(source)}</Streamdown>;
}
