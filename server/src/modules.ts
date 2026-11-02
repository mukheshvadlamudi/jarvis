import type { Services } from './app.ts';
import { setupMcp } from './mcp/module.ts';
import { setupMemory } from './memory/module.ts';
import { setupScheduler } from './scheduler/module.ts';
import { setupSkills } from './skills/module.ts';

/** Each feature module wires itself in with one line here (memory, skills, scheduler, workspaces, telegram). */
export function setupModules(s: Services): void {
  setupMemory(s);
  setupSkills(s);
  setupMcp(s);
  setupScheduler(s);
}
