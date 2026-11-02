import type { Services } from '../app.ts';
import { get } from '../db/index.ts';
import { Feeds } from './feeds.ts';
import { Projects } from './projects.ts';
import { setupResearch } from './research.ts';

export interface WorkspacesModule {
  feeds: Feeds;
  projects: Projects;
}

export function workspacesOf(s: Services): WorkspacesModule {
  const m = s.modules.workspaces as WorkspacesModule | undefined;
  if (!m) throw new Error('workspaces module not set up');
  return m;
}

export function setupWorkspaces(s: Services): WorkspacesModule {
  setupResearch(s);
  const feeds = new Feeds(s);
  const projects = new Projects(s);
  s.approvals.actions.set('open_pr', (a, decision) => projects.handleOpenPr(a, decision));

  // Mark feed items as seen once an Updates digest run has summarised them.
  s.orchestrator.afterRun.push((ctx) => {
    if (ctx.result.status !== 'done' || !ctx.task.schedule_id) return;
    const sch = get<{ built_in: string | null }>(s.db, 'SELECT built_in FROM schedules WHERE id = ?', ctx.task.schedule_id);
    if (sch?.built_in === 'updates_digest') feeds.markSeen('all', ctx.task.created_at);
  });

  const autoFetch = s.env.runner === 'real' || process.env.JARVIS_FEEDS_FETCH === '1';
  if (autoFetch) s.starters.push(() => feeds.start(() => s.config.get().feeds.fetchEveryHours));
  s.closers.push(() => feeds.stop());
  s.modules.workspaces = { feeds, projects } satisfies WorkspacesModule;
  return s.modules.workspaces as WorkspacesModule;
}
