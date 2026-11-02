import type { Services } from '../app.ts';
import { LearningLoop } from './learning.ts';
import { SkillRegistry } from './registry.ts';

export interface SkillsModule {
  registry: SkillRegistry;
  learning: LearningLoop;
}

export function skillsOf(s: Services): SkillsModule {
  const m = s.modules.skills as SkillsModule | undefined;
  if (!m) throw new Error('skills module not set up');
  return m;
}

export function setupSkills(s: Services): SkillsModule {
  const registry = new SkillRegistry(s.db, s.env.vault, s.bus);
  registry.scan();
  const learning = new LearningLoop({ db: s.db, bus: s.bus, registry, orchestrator: s.orchestrator, cfg: () => s.config.get().learning });
  s.orchestrator.afterRun.push(learning.hook);
  s.modules.skills = { registry, learning } satisfies SkillsModule;
  s.modules.skillList = () => registry.enabled().map((x) => ({ name: x.name, description: x.description }));
  s.bus.subscribe((e) => {
    if (e.type === 'memory.updated') {
      const paths = (e.data as { paths?: string[] })?.paths;
      if (!paths || paths.some((p) => p.startsWith('Skills/'))) registry.scan();
    }
  });
  return s.modules.skills as SkillsModule;
}
