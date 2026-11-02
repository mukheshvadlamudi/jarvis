/** Line-based unified diff (LCS). Notes are small, so O(n·m) is fine; very large inputs fall back to a full replace. */
export function unifiedDiff(oldText: string, newText: string, path: string, context = 3): string {
  const a = oldText === '' ? [] : oldText.replace(/\r\n/g, '\n').split('\n');
  const b = newText === '' ? [] : newText.replace(/\r\n/g, '\n').split('\n');
  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (a.length * b.length > 4_000_000) {
    return `${header}@@ -1,${a.length} +1,${b.length} @@\n${a.map((l) => `-${l}`).join('\n')}\n${b.map((l) => `+${l}`).join('\n')}\n`;
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops: Array<{ t: ' ' | '-' | '+'; line: string; ai: number; bi: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      ops.push({ t: ' ', line: a[i], ai: i, bi: j });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      ops.push({ t: '+', line: b[j], ai: i, bi: j });
      j++;
    } else {
      ops.push({ t: '-', line: a[i], ai: i, bi: j });
      i++;
    }
  }
  if (!ops.some((o) => o.t !== ' ')) return '';
  let out = header;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++;
      continue;
    }
    const start = Math.max(0, k - context);
    let end = k;
    let lastChange = k;
    while (end < ops.length && (ops[end].t !== ' ' || end - lastChange <= context * 2)) {
      if (ops[end].t !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const hunk = ops.slice(start, end);
    const aStart = hunk[0].ai + 1;
    const bStart = hunk[0].bi + 1;
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out += `@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@\n`;
    out += hunk.map((o) => `${o.t}${o.line}`).join('\n') + '\n';
    k = end;
  }
  return out;
}
