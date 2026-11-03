import { describe, expect, it, vi } from 'vitest';
import { seedIfEmpty } from '../../../../server/src/seed.ts';
import { makeCtx } from '../../../../server/test/helpers.ts';

describe('Ask demo data', () => {
  it('seeds typed consults, second opinions and rich answers without starting real agents or git', async () => {
    vi.stubEnv('JARVIS_SEED_REPOS', '0');
    const ctx = makeCtx();
    try {
      expect(seedIfEmpty(ctx.s)).toBe(true);
      expect(seedIfEmpty(ctx.s)).toBe(false);
      const auth = (await ctx.req('GET', '/api/conversations/t_demo_auth')).json;
      const main = auth.runs.find((r: { purpose: string }) => r.purpose === 'user_reply');
      const consult = auth.runs.find((r: { purpose: string }) => r.purpose === 'consult');
      const second = auth.runs.find((r: { purpose: string }) => r.purpose === 'second_opinion');
      expect(main.owner_text).toBe('Review the auth middleware in ClientEasy. What should we fix before the Northwind launch?');
      expect(consult).toMatchObject({ visibility: 'activity', owner_text: null, parent_run_id: main.id });
      expect(second).toMatchObject({ visibility: 'conversation', owner_text: null, parent_run_id: main.id });
      const backups = (await ctx.req('GET', '/api/conversations/t_demo_backups')).json;
      expect(backups.runs[0].answer).toContain('| Copy | Keep | Check |');
      expect(backups.runs[0].answer).toContain('```mermaid');
      expect(backups.runs[0].answer).toContain('```sh');
    } finally { await ctx.close(); vi.unstubAllEnvs(); }
  });
});
