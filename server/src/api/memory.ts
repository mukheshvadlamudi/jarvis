import type { Hono } from 'hono';
import type { Services } from '../app.ts';
import { CONSOLIDATION_PROMPT, migrationProposal, sizeAlerts } from '../memory/maintenance.ts';
import { memoryOf } from '../memory/module.ts';
import { bad, body } from './core.ts';

export function registerMemoryRoutes(app: Hono, s: Services): void {
  const m = () => memoryOf(s);

  app.get('/api/memory/overview', (c) => {
    const { vault, proposals } = m();
    const cfg = s.config.get();
    const core = vault.list().find((n) => n.path === 'CORE.md');
    const byType: Record<string, number> = {};
    for (const n of vault.list()) byType[n.type ?? 'other'] = (byType[n.type ?? 'other'] ?? 0) + 1;
    return c.json({
      vault: s.env.vault,
      demoCopy: s.env.vaultSource !== null,
      notes: vault.count(),
      fts: vault.fts,
      byType,
      coreTokens: core?.tokens ?? null,
      caps: { core: cfg.memory.coreCapTokens, project: cfg.memory.projectCapTokens, context: cfg.memory.contextBudgetTokens },
      sizes: sizeAlerts(vault, cfg),
      pending: proposals.pendingCount(),
    });
  });

  app.get('/api/memory/search', (c) => {
    const q = c.req.query('q') ?? '';
    const results = m().vault.search(q, { limit: Number(c.req.query('limit') ?? 20), type: c.req.query('type') || undefined });
    return c.json({ q, results });
  });

  app.get('/api/memory/notes', (c) => c.json({ notes: m().vault.list({ type: c.req.query('type') || undefined, prefix: c.req.query('prefix') || undefined }) }));

  app.get('/api/memory/note', (c) => {
    const path = c.req.query('path');
    if (!path) return bad(c, 'Pass ?path= with a vault-relative note path.');
    try {
      let note = m().vault.read(path.toLowerCase().endsWith('.md') ? path : `${path}.md`);
      if (!note && !path.includes('/')) {
        // Obsidian [[wikilink]]: resolve by note name anywhere in the vault.
        const name = path.replace(/\.md$/i, '').toLowerCase();
        const hit = m().vault.list().find((n) => n.path.split('/').pop()!.replace(/\.md$/i, '').toLowerCase() === name);
        if (hit) note = m().vault.read(hit.path);
      }
      return note ? c.json({ note }) : bad(c, `No note at ${path}.`, 404);
    } catch (err) {
      return bad(c, (err as Error).message);
    }
  });

  app.post('/api/memory/save', async (c) => {
    const b = await body<{ target?: string; content?: string; reason?: string; mode?: 'append' | 'replace' }>(c);
    if (!b.content?.trim()) return bad(c, 'Write something to save first.');
    try {
      const p = m().proposals.propose({ target: b.target ?? 'Inbox.md', content: b.content, reason: b.reason ?? 'Added from the web', mode: b.mode, autoApply: true });
      return c.json({ proposal: p });
    } catch (err) {
      return bad(c, (err as Error).message);
    }
  });

  app.get('/api/memory/proposals', (c) => c.json({ proposals: m().proposals.list(c.req.query('status') || undefined), pending: m().proposals.pendingCount() }));

  app.post('/api/memory/proposals/batch', async (c) => {
    const b = await body<{ ids?: string[]; decision?: string }>(c);
    if (b.decision !== 'approved' && b.decision !== 'rejected') return bad(c, 'decision must be "approved" or "rejected".');
    const results = (b.ids ?? []).map((id) => {
      try {
        return m().proposals.decide(id, b.decision as 'approved' | 'rejected');
      } catch (err) {
        return { id, error: (err as Error).message };
      }
    });
    return c.json({ results });
  });

  app.post('/api/memory/proposals/:id', async (c) => {
    const b = await body<{ decision?: string }>(c);
    if (b.decision !== 'approved' && b.decision !== 'rejected') return bad(c, 'decision must be "approved" or "rejected".');
    try {
      return c.json({ proposal: m().proposals.decide(c.req.param('id'), b.decision) });
    } catch (err) {
      const msg = (err as Error).message;
      return bad(c, msg === 'not_found' ? 'No proposal with that id.' : msg, msg === 'not_found' ? 404 : 409);
    }
  });

  app.get('/api/memory/migration', (c) => c.json({ items: migrationProposal(m().vault, s.config.get()), generatedAt: new Date().toISOString() }));
  app.get('/api/memory/consolidation-prompt', (c) => c.json({ prompt: CONSOLIDATION_PROMPT }));

  app.post('/api/memory/reindex', (c) => {
    const changed = m().vault.indexAll();
    return c.json({ changed, notes: m().vault.count() });
  });
}
