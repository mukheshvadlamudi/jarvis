import { Hono } from 'hono';
import { ApprovalService } from './approvals/service.ts';
import { ConfigStore } from './config.ts';
import type { Env } from './config.ts';
import { openDb } from './db/index.ts';
import type { Db } from './db/index.ts';
import { EventBus } from './events.ts';
import { createRunnerRegistry } from './runners/index.ts';
import type { RunnerRegistry } from './runners/index.ts';
import type { AgentRunner } from './runners/types.ts';
import { basicContextProvider } from './tasks/context.ts';
import { Orchestrator } from './tasks/orchestrator.ts';
import { TaskService } from './tasks/service.ts';
import type { AgentId } from './types.ts';
import { UsageMeter } from './usage/meter.ts';
import { registerRoutes } from './api/register.ts';
import { authMiddleware } from './api/auth.ts';
import { staticWeb } from './api/static.ts';
import { join } from 'node:path';

export interface Services {
  env: Env;
  db: Db;
  bus: EventBus;
  config: ConfigStore;
  tasks: TaskService;
  approvals: ApprovalService;
  usage: UsageMeter;
  runners: RunnerRegistry;
  orchestrator: Orchestrator;
  /** Module-specific services attach here (memory, skills, scheduler, workspaces, telegram). */
  modules: Record<string, unknown>;
  /** Background timers/closers registered by modules. */
  closers: Array<() => void | Promise<void>>;
  /** Called once after all routes are registered and before the server listens. */
  starters: Array<() => void | Promise<void>>;
}

export interface CreateAppOptions {
  env: Env;
  dbFile?: string;
  runnerOverrides?: Partial<Record<AgentId, AgentRunner>>;
}

export function createServices(opts: CreateAppOptions): Services {
  const { env } = opts;
  const db = openDb(opts.dbFile ?? join(env.dataDir, 'jarvis.db'));
  const bus = new EventBus();
  const config = new ConfigStore(env.dataDir);
  const tasks = new TaskService(db, bus);
  const approvals = new ApprovalService(db, bus);
  const usage = new UsageMeter({ db, bus, codexHome: env.codexHome, claudeHome: env.claudeHome, caps: () => config.get().usage.claudeSoftCaps });
  const runners = createRunnerRegistry(env.runner, { mockDelayMs: env.mockDelayMs }, opts.runnerOverrides);
  const orchestrator = new Orchestrator({
    db, bus, tasks, approvals, usage, runners, config,
    dataDir: env.dataDir,
    vaultPath: env.vault,
    context: basicContextProvider(() => config.get().memory.contextBudgetTokens),
  });
  return { env, db, bus, config, tasks, approvals, usage, runners, orchestrator, modules: {}, closers: [], starters: [] };
}

export function createApp(services: Services): Hono {
  const app = new Hono();
  app.use('/api/*', authMiddleware(services.env.accessToken));
  registerRoutes(app, services);
  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not_found', message: `No API route for ${c.req.method} ${c.req.path}` }, 404) : c.text('Not found', 404)));
  app.onError((err, c) => {
    const message = err instanceof Error ? err.message : String(err);
    const status = message === 'not_found' ? 404 : /illegal transition|cannot move|already|invalid|required/.test(message) ? 409 : 500;
    return c.json({ error: status === 500 ? 'internal' : 'conflict', message }, status);
  });
  app.get('*', staticWeb(services.env.webDist));
  return app;
}
