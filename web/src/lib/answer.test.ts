import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Answer, answerHref } from './answer.tsx';

const render = (source: string, streaming = false) => renderToStaticMarkup(createElement(Answer, { source, streaming }));
describe('Ask answers', () => {
  it('renders GFM tables, nested lists and incomplete streaming formatting', () => {
    const html = render('| Check | State |\n|---|---|\n| Restore | **Open** |\n\n- First\n  - Nested');
    expect(html).toContain('table-wrap'); expect(html).toContain('<table>'); expect(html).toContain('<strong'); expect(html).toContain('Nested');
    expect(render('A **partial answer', true)).toContain('partial answer');
  });
  it('keeps code copy and highlighting', () => {
    const html = render('```ts\nconst count = 42;\n```');
    expect(html).toContain('Copy code'); expect(html).toContain('tok-k'); expect(html).toContain('tok-n');
    expect(render('```\necho hello\n```')).toContain('Copy code');
  });
  it('sanitizes URLs, suppresses HTML and remote images, and preserves vault links', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,test', '//tracker.example/x', 'https://safe.test/\nattack', 'vbscript:msgbox(1)', '/\\evil.test', '/path\nattack']) expect(answerHref(bad)).toBeUndefined();
    expect(answerHref('https://example.com')).toBe('https://example.com');
    const html = render('![Tracking image](https://tracker.example/pixel)\n\n[x](javascript:alert)\n\n<script>alert(1)</script>\n\n[[Projects/ClientEasy.md|ClientEasy]]');
    expect(html).not.toContain('<img'); expect(html).not.toContain('<script'); expect(html).not.toContain('javascript:'); expect(html).toContain('/memory?note=Projects%2FClientEasy.md');
    expect(render('`[[literal]]`\n\n```text\n[[also literal]]\n```')).not.toContain('/memory?note=');
  });
});
