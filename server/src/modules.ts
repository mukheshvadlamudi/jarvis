import type { Services } from './app.ts';

/** Each feature module wires itself in with one line here (memory, skills, scheduler, workspaces, telegram). */
export function setupModules(s: Services): void {
  void s;
}
