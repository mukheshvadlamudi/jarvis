export interface Fact {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  validFrom: string | null;
  validTo: string | null;
  source: string;
  supersedes: string | null;
}

// Under ## Facts, each observation is one `- fact: { ... }` JSON line. Named fields keep
// it readable in Markdown; JSON escaping preserves pipes, quotes and newlines losslessly.
export const factLine = (fact: Fact): string => `- fact: ${JSON.stringify(fact)}`;
export const factKey = (s: string): string => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const isCurrent = (f: Fact, date = today()): boolean => (!f.validFrom || f.validFrom <= date) && (!f.validTo || f.validTo > date);

export function mapFacts(text: string, map: (fact: Fact, line: string) => string): string {
  let section = false;
  return text.split('\n').map((line) => {
    if (/^##\s/.test(line)) section = /^## Facts\s*\r?$/.test(line);
    if (!section || !line.startsWith('- fact: ')) return line;
    try {
      const f = JSON.parse(line.slice(8)) as Fact;
      if (!f.id || !['subject', 'predicate', 'value', 'source'].every((k) => typeof (f as unknown as Record<string, unknown>)[k] === 'string') ||
        ![f.validFrom, f.validTo, f.supersedes].every((v) => v === null || typeof v === 'string')) return line;
      return map(f, line);
    } catch { return line; }
  }).join('\n');
}

export function factsIn(text: string): Fact[] {
  const facts: Fact[] = [];
  mapFacts(text, (f, line) => { facts.push(f); return line; });
  return facts;
}

export const currentFactsText = (text: string): string => mapFacts(text, (f, line) => isCurrent(f) ? line : '');

export function appendFact(text: string, fact: Fact): string {
  const heading = /^## Facts\s*\r?$/m.exec(text);
  if (!heading) return `${text.trimEnd()}\n\n## Facts\n\n${factLine(fact)}\n`;
  const start = heading.index + heading[0].length;
  return `${text.slice(0, start)}\n${factLine(fact)}${text.slice(start)}`;
}
