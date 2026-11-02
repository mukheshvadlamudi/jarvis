import type { Services } from './app.ts';
import { setupCollaboration } from './collab/index.ts';
import { setupMcp } from './mcp/module.ts';
import { setupMemory } from './memory/module.ts';
import { setupScheduler } from './scheduler/module.ts';
import { setupSkills } from './skills/module.ts';
import { setupTelegram } from './telegram/module.ts';
import { setupWorkspaces } from './workspaces/module.ts';

/** Each feature module wires itself in with one line here (memory, skills, scheduler, workspaces, telegram). */
export function setupModules(s: Services): void {
  setupMemory(s);
  setupSkills(s);
  setupMcp(s);
  setupScheduler(s);
  setupWorkspaces(s);
  setupTelegram(s);
  setupCollaboration(s);
}
