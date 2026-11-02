import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv.ts';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF and newlines in cells', () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",2')).toEqual([
      ['a', 'b'],
      ['x, y', 'say "hi"'],
      ['multi\nline', '2'],
    ]);
  });
  it('detects TSV', () => {
    expect(parseCsv('a\tb\n1\t2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });
});
