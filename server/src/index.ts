import { serve } from '@hono/node-server';
import { createApp, createServices } from './app.ts';
import { loadEnv } from './config.ts';
import { setupModules } from './modules.ts';
import { seedIfEmpty } from './seed.ts';
import { presentBillingKeys } from './util/env.ts';
import { logger } from './util/log.ts';

const log = logger('jarvis');

async function main(): Promise<void> {
  const env = loadEnv();
  const keys = presentBillingKeys();
  if (keys.length) {
    log.warn(`${keys.join(', ')} set in this environment. Jarvis removes them from every agent it starts, so runs still use your Claude/ChatGPT plan logins.`);
  }
  const s = createServices({ env });
  s.orchestrator.recover();
  setupModules(s);
  if (env.seed && seedIfEmpty(s)) log.info('seeded demo data (mock mode)');
  const app = createApp(s);
  for (const start of s.starters) await start();

  s.usage.start(s.config.get().usage.pollSeconds);
  const expiry = setInterval(() => s.approvals.expireOld(s.config.get().approvals.expiryHours), 10 * 60_000);
  expiry.unref();
  s.approvals.expireOld(s.config.get().approvals.expiryHours);

  const server = serve({ fetch: app.fetch, hostname: env.bind, port: env.port }, (info) => {
    log.info(`Jarvis on http://${info.address}:${info.port} · runner=${env.runner} · vault=${env.vault}`);
  });
  s.orchestrator.tick();

  const shutdown = async (signal: string) => {
    log.info(`${signal}: shutting down`);
    s.orchestrator.stop();
    s.usage.stop();
    for (const close of s.closers) {
      try {
        await close();
      } catch (err) {
        log.warn('closer failed', err);
      }
    }
    server.close();
    s.db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  log.error('fatal', err);
  process.exit(1);
});
