import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, TaskType } from './types.ts';
import { logger } from './util/log.ts';

const log = logger('config');

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface RouterConfig {
  defaults: Record<TaskType, AgentId>;
  effortOverride: { high?: AgentId; medium?: AgentId; low?: AgentId };
  scheduledTasks: AgentId;
  /** Plain questions on Ask: the agent with more plan room left ('headroom'), or always one agent. */
  chat: 'headroom' | AgentId;
  /** When an agent hits its plan limit mid-task, continue the task on the other agent. */
  switchOnLimit?: boolean;
  fallbackAtPercent: number;
}

export interface JarvisConfig {
  router: RouterConfig;
  maxConcurrentRuns: number;
  memory: { contextBudgetTokens: number; coreCapTokens: number; projectCapTokens: number };
  learning: { enabled: boolean; minToolCalls: number };
  usage: { pollSeconds: number };
  approvals: { expiryHours: number };
  classifier: { useAgent: boolean };
  feeds: { fetchEveryHours: number };
  telegram: { enabled: boolean };
  /** Per-agent harness settings. Empty strings mean "use the CLI's own default". */
  agents: {
    claude: { model: string; chrome: boolean; effort: { low: string; medium: string; high: string } };
    codex: { model: string; effort: { low: string; medium: string; high: string } };
  };
  collaboration: { maxConsultsPerTask: number; autoHandoffReview: boolean };
  voice: { enabled: boolean };
}

export const DEFAULT_CONFIG: JarvisConfig = {
  router: {
    defaults: { code: 'claude', write: 'claude', research: 'codex', admin: 'codex', update: 'codex', memory: 'codex', other: 'codex' },
    effortOverride: { high: 'claude' },
    scheduledTasks: 'codex',
    chat: 'headroom',
    switchOnLimit: true,
    fallbackAtPercent: 85,
  },
  maxConcurrentRuns: 2,
  memory: { contextBudgetTokens: 6000, coreCapTokens: 2000, projectCapTokens: 3000 },
  learning: { enabled: true, minToolCalls: 8 },
  usage: { pollSeconds: 120 },
  approvals: { expiryHours: 24 },
  classifier: { useAgent: false },
  feeds: { fetchEveryHours: 6 },
  telegram: { enabled: true },
  agents: {
    claude: { model: '', chrome: false, effort: { low: 'low', medium: '', high: 'high' } },
    codex: { model: '', effort: { low: 'low', medium: '', high: 'high' } },
  },
  collaboration: { maxConsultsPerTask: 2, autoHandoffReview: false },
  voice: { enabled: true },
};

export const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
export const CODEX_EFFORTS = ['', 'minimal', 'low', 'medium', 'high', 'xhigh'];

export interface Env {
  bind: string;
  port: number;
  accessToken: string | null;
  vault: string;
  /** Set when the vault is a working copy of fixtures/vault (mock mode never writes the fixtures). */
  vaultSource: string | null;
  runner: 'mock' | 'real';
  demo: boolean;
  dataDir: string;
  codexHome: string;
  claudeHome: string;
  /** Where the skills sync writes; defaults to the real homes, tests point it at a temp dir. */
  skillsTargets: { claude: string; codex: string };
  seed: boolean;
  mockDelayMs: number;
  telegramToken: string | null;
  /** Gemini Live key for the voice brain (server-side only; the browser gets ephemeral tokens). */
  geminiKey: string | null;
  /** Optional pinned Gemini Live model; otherwise the newest native-audio Live model is picked. */
  geminiLiveModel: string | null;
  telegramChatId: string | null;
  webDist: string;
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const runner = source.JARVIS_RUNNER === 'mock' ? 'mock' : 'real';
  const accessToken = source.JARVIS_ACCESS_TOKEN?.trim() || null;
  let bind = source.JARVIS_BIND?.trim() || '127.0.0.1';
  if (!isLoopback(bind) && !accessToken) {
    log.warn(`JARVIS_BIND=${bind} ignored because JARVIS_ACCESS_TOKEN is not set; binding 127.0.0.1`);
    bind = '127.0.0.1';
  }
  const home = homedir();
  const dataDir = resolve(REPO_ROOT, source.JARVIS_DATA_DIR || 'data');
  let vault = resolve(REPO_ROOT, source.JARVIS_VAULT || 'fixtures/vault');
  let vaultSource: string | null = null;
  if (vault === resolve(REPO_ROOT, 'fixtures/vault') && source.JARVIS_VAULT_WRITE_FIXTURES !== '1') {
    vaultSource = vault;
    vault = join(dataDir, 'demo-vault');
  }
  const codexHome = resolve(source.JARVIS_CODEX_HOME || source.CODEX_HOME || (runner === 'mock' ? join(REPO_ROOT, 'fixtures/usage/codex') : join(home, '.codex')));
  const claudeHome = resolve(source.JARVIS_CLAUDE_HOME || (runner === 'mock' ? join(REPO_ROOT, 'fixtures/usage/claude') : join(home, '.claude')));
  return {
    bind,
    port: Number(source.JARVIS_PORT || 4317),
    accessToken,
    vault,
    vaultSource,
    runner,
    demo: source.JARVIS_DEMO === '1',
    dataDir,
    codexHome,
    claudeHome,
    skillsTargets: {
      claude: resolve(source.JARVIS_SKILLS_CLAUDE_DIR || (runner === 'mock' ? join(dataDir, 'skills-dry-run/claude') : join(home, '.claude', 'skills'))),
      codex: resolve(source.JARVIS_SKILLS_CODEX_DIR || (runner === 'mock' ? join(dataDir, 'skills-dry-run/codex') : join(home, '.codex', 'skills'))),
    },
    seed: source.JARVIS_SEED ? source.JARVIS_SEED !== '0' : runner === 'mock',
    mockDelayMs: Number(source.JARVIS_MOCK_DELAY_MS ?? (runner === 'mock' && source.NODE_ENV !== 'test' && !source.VITEST ? 900 : 0)),
    telegramToken: source.TELEGRAM_BOT_TOKEN?.trim() || null,
    geminiKey: source.GEMINI_API_KEY?.trim() || null,
    geminiLiveModel: source.GEMINI_LIVE_MODEL?.trim() || null,
    telegramChatId: source.TELEGRAM_ALLOWED_CHAT_ID?.trim() || null,
    webDist: resolve(REPO_ROOT, 'web/dist'),
  };
}

type Plain = Record<string, unknown>;
function isPlain(v: unknown): v is Plain {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` onto `base`, ignoring keys that do not exist in `base`. */
export function mergeKnown<T>(base: T, patch: unknown): T {
  if (!isPlain(base) || !isPlain(patch)) return base;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in base)) continue;
    const cur = (base as Plain)[k];
    if (isPlain(cur)) out[k] = mergeKnown(cur, v);
    else if (typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

const AGENTS = ['claude', 'codex'];

export function validateConfig(c: JarvisConfig): string[] {
  const errors: string[] = [];
  for (const [type, agent] of Object.entries(c.router.defaults)) {
    if (!AGENTS.includes(agent)) errors.push(`router.defaults.${type} must be claude or codex`);
  }
  for (const [effort, agent] of Object.entries(c.router.effortOverride)) {
    if (agent !== undefined && !AGENTS.includes(agent)) errors.push(`router.effortOverride.${effort} must be claude or codex`);
  }
  if (!['headroom', ...AGENTS].includes(c.router.chat)) errors.push('router.chat must be headroom, claude or codex');
  if (!AGENTS.includes(c.router.scheduledTasks)) errors.push('router.scheduledTasks must be claude or codex');
  if (!(c.router.fallbackAtPercent > 0 && c.router.fallbackAtPercent <= 100)) errors.push('router.fallbackAtPercent must be between 1 and 100');
  if (!Number.isInteger(c.maxConcurrentRuns) || c.maxConcurrentRuns < 1 || c.maxConcurrentRuns > 4) errors.push('maxConcurrentRuns must be an integer from 1 to 4 (8 GB RAM budget)');
  if (c.memory.contextBudgetTokens < 1000 || c.memory.contextBudgetTokens > 50000) errors.push('memory.contextBudgetTokens must be between 1,000 and 50,000');
  if (c.learning.minToolCalls < 1) errors.push('learning.minToolCalls must be at least 1');
  if (c.usage.pollSeconds < 30) errors.push('usage.pollSeconds must be at least 30');
  if (c.approvals.expiryHours <= 0) errors.push('approvals.expiryHours must be positive');
  if (c.feeds.fetchEveryHours < 1) errors.push('feeds.fetchEveryHours must be at least 1');
  for (const level of ['low', 'medium', 'high'] as const) {
    if (!CLAUDE_EFFORTS.includes(c.agents.claude.effort[level])) errors.push(`agents.claude.effort.${level} must be one of ${CLAUDE_EFFORTS.filter(Boolean).join(', ')} (or empty)`);
    if (!CODEX_EFFORTS.includes(c.agents.codex.effort[level])) errors.push(`agents.codex.effort.${level} must be one of ${CODEX_EFFORTS.filter(Boolean).join(', ')} (or empty)`);
  }
  for (const a of ['claude', 'codex'] as const) {
    if (!/^[\w.:\-\[\]]*$/.test(c.agents[a].model)) errors.push(`agents.${a}.model has unexpected characters`);
  }
  if (!Number.isInteger(c.collaboration.maxConsultsPerTask) || c.collaboration.maxConsultsPerTask < 0 || c.collaboration.maxConsultsPerTask > 5) errors.push('collaboration.maxConsultsPerTask must be 0–5');
  return errors;
}

export class ConfigStore {
  readonly file: string;
  private current: JarvisConfig;
  private listeners: Array<(c: JarvisConfig) => void> = [];

  constructor(dataDir: string) {
    this.file = join(dataDir, 'config.json');
    this.current = structuredClone(DEFAULT_CONFIG);
    if (existsSync(this.file)) {
      try {
        const merged = mergeKnown(structuredClone(DEFAULT_CONFIG), JSON.parse(readFileSync(this.file, 'utf8')));
        const errors = validateConfig(merged);
        if (errors.length) log.warn(`config.json has problems, using defaults for now: ${errors.join('; ')}`);
        else this.current = merged;
      } catch (err) {
        log.warn('config.json could not be parsed, using defaults', err);
      }
    }
  }

  get(): JarvisConfig {
    return this.current;
  }

  /** Apply a partial update. Returns validation errors (and changes nothing) if invalid. */
  update(patch: unknown): { ok: true; config: JarvisConfig } | { ok: false; errors: string[] } {
    const next = mergeKnown(structuredClone(this.current), patch);
    const errors = validateConfig(next);
    if (errors.length) return { ok: false, errors };
    this.current = next;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(next, null, 2));
    renameSync(tmp, this.file);
    for (const l of this.listeners) l(next);
    return { ok: true, config: next };
  }

  onChange(fn: (c: JarvisConfig) => void): void {
    this.listeners.push(fn);
  }
}
