import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createApp, createServices } from '../src/app.ts';
import type { Services } from '../src/app.ts';
import { loadEnv } from '../src/config.ts';
import { setupModules } from '../src/modules.ts';
import type { AgentRunner } from '../src/runners/types.ts';
import type { AgentId } from '../src/types.ts';

export const REPO = resolve(import.meta.dirname, '..', '..');
export const FIXTURE_VAULT = join(REPO, 'fixtures', 'vault');

export interface TestCtx {
  s: Services;
  app: ReturnType<typeof createApp>;
  dir: string;
  req: (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
  close: () => Promise<void>;
}

export function makeCtx(opts: { mockDelayMs?: number; env?: Record<string, string>; runnerOverrides?: Partial<Record<AgentId, AgentRunner>> } = {}): TestCtx {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-test-'));
  const env = loadEnv({
    JARVIS_RUNNER: 'mock',
    JARVIS_DATA_DIR: dir,
    JARVIS_VAULT: FIXTURE_VAULT,
    JARVIS_SEED: '0',
    JARVIS_MOCK_DELAY_MS: String(opts.mockDelayMs ?? 0),
    JARVIS_SKILLS_CLAUDE_DIR: join(dir, 'home/.claude/skills'),
    JARVIS_SKILLS_CODEX_DIR: join(dir, 'home/.codex/skills'),
    JARVIS_SILENT: '1',
    ...opts.env,
  });
  const s = createServices({ env, runnerOverrides: opts.runnerOverrides });
  setupModules(s);
  const app = createApp(s);
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json };
  };
  return {
    s,
    app,
    dir,
    req,
    close: async () => {
      if (!s.db.isOpen) return;
      await s.orchestrator.shutdown();
      for (const c of s.closers) await c();
      s.db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000, stepMs = 10): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v as T;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
