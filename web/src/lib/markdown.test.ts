import { describe, expect, it } from 'vitest';
import { parseBlocks } from './markdown.tsx';

describe('markdown blocks', () => {
  it('parses the common vault shapes', () => {
    const b = parseBlocks('# Title\n\nPara one\ncontinues.\n\n- a\n- [x] done\n\n1. first\n\n> quote\n\n```ts\nconst x = 1;\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n---');
    expect(b.map((x) => x.t)).toEqual(['h', 'p', 'ul', 'ol', 'quote', 'code', 'table', 'hr']);
    expect(b[1]).toEqual({ t: 'p', text: 'Para one continues.' });
    expect(b[2]).toEqual({ t: 'ul', items: [{ text: 'a' }, { text: 'done', checked: true }] });
    expect(b[6]).toEqual({ t: 'table', head: ['A', 'B'], rows: [['1', '2']] });
  });
});
