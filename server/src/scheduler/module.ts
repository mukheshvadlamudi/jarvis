import type { Services } from '../app.ts';
import { Scheduler } from './service.ts';

export function schedulerOf(s: Services): Scheduler {
  const m = s.modules.scheduler as Scheduler | undefined;
  if (!m) throw new Error('scheduler module not set up');
  return m;
}

export function setupScheduler(s: Services): Scheduler {
  const scheduler = new Scheduler(s);
  scheduler.ensureBuiltIns();
  s.modules.scheduler = scheduler;
  s.starters.push(() => scheduler.start());
  s.closers.push(() => scheduler.stop());
  return scheduler;
}
