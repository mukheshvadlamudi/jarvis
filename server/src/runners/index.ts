import type { AgentId } from '../types.ts';
import type { AgentRunner } from './types.ts';
import { createClaudeRunner } from './claude.ts';
import { createCodexRunner } from './codex.ts';
import { createMockRunner } from './mock.ts';

export interface RunnerRegistry {
  get(agent: AgentId): AgentRunner;
  readonly mode: 'mock' | 'real';
}

/** Real runners load their SDKs lazily, so mock mode never pulls them into memory. */
export function createRunnerRegistry(mode: 'mock' | 'real', opts: { mockDelayMs: number }, overrides: Partial<Record<AgentId, AgentRunner>> = {}): RunnerRegistry {
  const mock = createMockRunner({ delayMs: opts.mockDelayMs });
  const real: Partial<Record<AgentId, AgentRunner>> = {};
  return {
    mode,
    get(agent: AgentId): AgentRunner {
      if (overrides[agent]) return overrides[agent]!;
      if (mode === 'mock') return mock;
      real[agent] ??= agent === 'claude' ? createClaudeRunner() : createCodexRunner();
      return real[agent]!;
    },
  };
}
