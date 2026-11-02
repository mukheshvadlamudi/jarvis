import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Services } from '../app.ts';
import { get } from '../db/index.ts';
import type { AgentId, AgentUsage, Run } from '../types.ts';
import { logger } from '../util/log.ts';
import { probeClaude } from './probe.ts';
import type { ClaudeProbeResult } from './probe.ts';
import { ConnectorService, realExec } from '../connectors/service.ts';

const log = logger('agents');

export interface ModelOption {
  value: string;
  label: string;
  description: string;
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  /** ready | busy | signed_out | limited (at the router's fallback threshold) | unknown (mock). */
  state: 'ready' | 'busy' | 'signed_out' | 'limited';
  detail: string;
  signedIn: boolean;
  authError: string | null;
  busy: Array<{ taskId: string; title: string; mode: string }>;
  usage: AgentUsage;
  models: ModelOption[];
  defaultModel: string;
  subscription: string | null;
}

const AUTH_ERROR = /oauth|authenticat|not logged in|log ?in again|401|unauthori[sz]ed|credential/i;
const USAGE_EVERY_MS = 5 * 60_000;
const MODELS_EVERY_MS = 6 * 3600_000;

/** Shown in mock mode (demo, tests, screenshots) where no real CLI is ever called. */
const MOCK_MODELS: Record<AgentId, ModelOption[]> = {
  claude: [
    { value: 'default', label: 'Default (recommended)', description: 'Your plan’s default model' },
    { value: 'opus', label: 'Opus', description: 'Most capable, uses the plan fastest' },
    { value: 'sonnet', label: 'Sonnet', description: 'Strong everyday model' },
    { value: 'haiku', label: 'Haiku', description: 'Fastest for quick answers' },
  ],
  codex: [
    { value: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', description: 'Default Codex model' },
    { value: 'gpt-5.6-luna', label: 'GPT-5.6-Luna', description: 'Lighter and faster' },
  ],
};

/**
 * What each agent can do right now: signed in or not, busy with what, real plan usage, and the
 * models its own CLI offers. Claude facts come from a prompt-free Claude Code session (probe.ts);
 * Codex facts from its own files (models_cache.json, config.toml). Nothing here calls a model.
 */
export class AgentsService {
  private s: Services;
  private probe: typeof probeClaude;
  private claude: { models: ModelOption[]; modelsAt: number; subscription: string | null; probeError: string | null } = { models: [], modelsAt: 0, subscription: null, probeError: null };
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(s: Services, deps: { probe?: typeof probeClaude } = {}) {
    this.s = s;
    this.probe = deps.probe ?? probeClaude;
  }

  get real(): boolean {
    return this.s.env.runner === 'real';
  }

  start(): void {
    if (!this.real) return;
    const first = setTimeout(() => void this.refresh({ models: true }), 3000);
    first.unref();
    this.timer = setInterval(() => void this.refresh({ models: Date.now() - this.claude.modelsAt > MODELS_EVERY_MS }), USAGE_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Re-read Claude's real usage (and its model list when asked). Concurrent calls share one probe. */
  refresh(opts: { models?: boolean } = {}): Promise<void> {
    if (!this.real) return Promise.resolve();
    this.inflight ??= (async () => {
      const r = await this.probe({ usage: true, models: opts.models || !this.claude.models.length });
      this.apply(r);
    })()
      .catch((err) => log.warn('claude probe failed', err))
      .finally(() => (this.inflight = null));
    return this.inflight;
  }

  /** Record a probe result. Exported shape is tested directly. */
  apply(r: ClaudeProbeResult): void {
    this.claude.probeError = r.errors.length ? r.errors.join('; ') : null;
    if (r.models?.length) {
      this.claude.models = r.models.map((m) => ({ value: m.value, label: m.displayName, description: m.description }));
      this.claude.modelsAt = Date.now();
    }
    if (r.usage) {
      this.claude.subscription = r.usage.subscription;
      for (const [window, w] of [['five_hour', r.usage.five_hour], ['weekly', r.usage.weekly]] as const) {
        if (w && typeof w.utilization === 'number') {
          const resetsAt = w.resets_at ? new Date(w.resets_at).toISOString() : null;
          this.s.usage.recordReading({ agent: 'claude', window, usedPercent: w.utilization, resetsAt, source: 'claude-usage' });
        }
      }
    }
    this.s.bus.publish('agents.updated', { at: new Date().toISOString() });
  }

  models(agent: AgentId): ModelOption[] {
    if (!this.real) return MOCK_MODELS[agent];
    if (agent === 'claude') return this.claude.models.length ? this.claude.models : MOCK_MODELS.claude.slice(0, 1);
    return codexModels(this.s.env.codexHome);
  }

  defaultModel(agent: AgentId): string {
    const configured = this.s.config.get().agents[agent].model;
    if (configured) return configured;
    if (agent === 'claude') return 'default';
    return (this.real ? codexConfiguredModel(this.s.env.codexHome) : null) ?? this.models('codex')[0]?.value ?? '';
  }

  /** The newest run's error for this agent if it was a sign-in failure and nothing has worked since. */
  private authError(agent: AgentId): string | null {
    const last = get<Pick<Run, 'status' | 'error'>>(this.s.db, "SELECT status, error FROM runs WHERE agent = ? AND status IN ('done', 'failed') ORDER BY started_at DESC LIMIT 1", agent);
    if (last?.status === 'failed' && last.error && AUTH_ERROR.test(last.error)) return last.error;
    if (agent === 'claude' && this.claude.probeError && AUTH_ERROR.test(this.claude.probeError)) return this.claude.probeError;
    return null;
  }

  private signedIn(agent: AgentId): boolean {
    if (!this.real) return true;
    if (agent === 'claude') return process.platform === 'darwin' || existsSync(join(this.s.env.claudeHome, '.credentials.json'));
    return existsSync(join(this.s.env.codexHome, 'auth.json'));
  }

  status(): Record<AgentId, AgentStatus> {
    const usage = this.s.usage.current();
    const threshold = this.s.config.get().router.fallbackAtPercent;
    const activeRuns = this.s.orchestrator.activeRuns();
    const out = {} as Record<AgentId, AgentStatus>;
    for (const id of ['claude', 'codex'] as const) {
      const busy = activeRuns.filter((r) => r.agent === id).map((r) => {
        const t = this.s.tasks.get(r.taskId);
        return { taskId: r.taskId, title: t?.title ?? 'A task', mode: t?.mode ?? 'task' };
      });
      const signedIn = this.signedIn(id);
      const authError = this.authError(id);
      const hot = [usage[id].five_hour, usage[id].weekly].filter((w) => w && w.usedPercent >= threshold);
      let state: AgentStatus['state'] = 'ready';
      let detail = 'Ready';
      if (!signedIn || authError) {
        state = 'signed_out';
        detail = authError ? 'Sign-in expired' : 'Not signed in';
      } else if (busy.length) {
        state = 'busy';
        detail = busy.length === 1 ? busy[0].title : `${busy.length} runs`;
      } else if (hot.length) {
        state = 'limited';
        detail = `Near its plan limit (${Math.round(Math.max(...hot.map((w) => w!.usedPercent)))}%)`;
      }
      out[id] = {
        id,
        label: id === 'claude' ? 'Claude' : 'Codex',
        state,
        detail,
        signedIn,
        authError,
        busy,
        usage: usage[id],
        models: this.models(id),
        defaultModel: this.defaultModel(id),
        subscription: id === 'claude' ? this.claude.subscription : null,
      };
    }
    return out;
  }
}

/** Models the Codex CLI lists for this account (it caches them in ~/.codex/models_cache.json). */
export function codexModels(codexHome = join(homedir(), '.codex')): ModelOption[] {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome, 'models_cache.json'), 'utf8')) as { models?: Array<Record<string, unknown>> };
    const list = (raw.models ?? [])
      .filter((m) => typeof m.slug === 'string' && m.visibility !== 'hide')
      .map((m) => ({ value: String(m.slug), label: String(m.display_name ?? m.slug), description: String(m.description ?? '') }));
    if (list.length) return list;
  } catch {
    // no cache yet (Codex never ran) — fall through
  }
  return [];
}

/** `model = "…"` from ~/.codex/config.toml, the model Codex uses when Jarvis sets none. */
export function codexConfiguredModel(codexHome = join(homedir(), '.codex')): string | null {
  try {
    const m = /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(codexHome, 'config.toml'), 'utf8'));
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function agentsOf(s: Services): AgentsService {
  const a = s.modules.agents as AgentsService | undefined;
  if (!a) throw new Error('agents module not set up');
  return a;
}

export function setupAgents(s: Services): AgentsService {
  const a = new AgentsService(s);
  s.modules.agents = a;
  // Connectors: Claude's list comes from the same prompt-free probe; mock mode never runs a CLI.
  s.modules.connectors = new ConnectorService({
    exec: s.env.runner === 'real' ? realExec : async () => ({ code: 0, stdout: '[]', stderr: '' }),
    claudeStatus: async () => {
      if (s.env.runner !== 'real') return [];
      const r = await probeClaude({ mcp: true });
      if (!r.mcp) throw new Error(r.errors.join('; ') || 'no connector status');
      return r.mcp.map((m) => ({ name: m.name, status: m.status, scope: m.scope, source: m.source, error: m.error, config: m.config as { type?: string; command?: string; url?: string } | undefined, tools: m.tools }));
    },
  });
  s.starters.push(() => a.start());
  s.closers.push(() => a.stop());
  return a;
}
