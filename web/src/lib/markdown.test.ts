import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, parseBlocks, plainText } from './markdown.tsx';

const html = (md: string) => renderToStaticMarkup(createElement(Markdown, { source: md }));

describe('markdown blocks', () => {
  it('parses the common vault shapes', () => {
    const b = parseBlocks('# Title\n\nPara one\ncontinues.\n\n- a\n- [x] done\n\n1. first\n\n> quote\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'code', 'table', 'hr']);
    expect(b[1]).toEqual({ t: 'p', text: 'Para one continues.' });
    expect(b[2]).toEqual({ t: 'ul', items: [{ text: 'a' }, { text: 'done', checked: true }] });
    expect(b[6]).toEqual({ t: 'table', head: ['A', 'B'], rows: [['1', '2']] });
  });

  it('keeps loose lists together and remembers where a numbered list starts', () => {
    const b = parseBlocks('3. three\n\n4. four\n\nafter');
    expect(b).toEqual([{ t: 'ol', items: [{ text: 'three' }, { text: 'four' }], start: 3 }, { t: 'p', text: 'after' }]);
  });

  it('reads table alignment and starts a table right after a paragraph line', () => {
    const b = parseBlocks('Plans:\n| Plan | Price |\n|:--|--:|\n| Pro | $20 |');
    expect(b[0]).toEqual({ t: 'p', text: 'Plans:' });
    expect(b[1]).toEqual({ t: 'table', head: ['Plan', 'Price'], rows: [['Pro', '$20']], align: ['left', 'right'] });
  });
});

describe('markdown rendering', () => {
  it('renders an agent answer the way the Claude and Codex apps do', () => {
    const out = html('As of **3 November, 6:40 a.m. IST**:\n\n- **OpenAI agents are moving into operations.** See [ADNOC announcement](https://www.adnoc.ae/news) and https://example.com/x.\n- ~~old~~ new, *really*');
    expect(out).toContain('<strong>3 November, 6:40 a.m. IST</strong>');
    expect(out).toContain('<a href="https://www.adnoc.ae/news" target="_blank" rel="noreferrer">ADNOC announcement</a>');
    expect(out).toContain('<a href="https://example.com/x" target="_blank" rel="noreferrer">example.com/x</a>.');
    expect(out).toContain('<del>old</del>');
    expect(out).toContain('<em>really</em>');
    expect(out).not.toContain('**');
  });

  it('nests formatting inside links and bold', () => {
    const out = html('**Read [the `docs`](https://a.dev) first**');
    expect(out).toBe('<div class="prose"><p><strong>Read <a href="https://a.dev" target="_blank" rel="noreferrer">the <code>docs</code></a> first</strong></p></div>');
  });

  it('leaves snake_case and lone asterisks alone, and never renders unsafe links', () => {
    const out = html('use my_var_name and 2 * 3 * 4, [x](javascript:alert(1))');
    expect(out).toContain('my_var_name');
    expect(out).toContain('2 * 3 * 4');
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<em>');
  });

  it('frames code with its language and a copy button, and highlights tokens', () => {
    const out = html('```ts\nconst n = 42; // answer\n```');
    expect(out).toContain('<span class="code-lang">ts</span>');
    expect(out).toContain('aria-label="Copy code"');
    expect(out).toContain('<span class="tok-k">const</span>');
    expect(out).toContain('<span class="tok-n">42</span>');
    expect(out).toContain('<span class="tok-c">// answer</span>');
  });

  it('wraps tables so wide ones scroll on their own', () => {
    expect(html('| A | B |\n|---|---|\n| 1 | **2** |')).toContain('<div class="table-wrap"><table>');
  });
});

describe('plain text for summaries and speech', () => {
  it('strips Markdown without losing the words', () => {
    expect(plainText('## Result\n\n- **Fixed** the [login bug](https://x.dev) in `auth.ts`\n- ~~old~~')).toBe('Result Fixed the login bug in auth.ts old');
  });
});
