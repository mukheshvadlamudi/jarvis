import { AlertTriangle, Check } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ErrorBox, PageHead, Segmented, Skeleton, Switch } from '../components/ui.tsx';
import { put } from '../lib/api.ts';
import { TYPE_LABEL } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import { setTheme, useTheme } from '../lib/theme.ts';
import type { ThemePref } from '../lib/theme.ts';
import { toast } from '../lib/toast.ts';

type Agent = 'claude' | 'codex';
interface Config {
  router: { defaults: Record<string, Agent>; effortOverride: { high?: Agent; medium?: Agent; low?: Agent }; scheduledTasks: Agent; fallbackAtPercent: number };
  maxConcurrentRuns: number;
  memory: { contextBudgetTokens: number; coreCapTokens: number; projectCapTokens: number };
  learning: { enabled: boolean; minToolCalls: number };
  usage: { pollSeconds: number; claudeSoftCaps: { fiveHourTokens: number; weeklyTokens: number } };
  approvals: { expiryHours: number };
  classifier: { useAgent: boolean };
  feeds: { fetchEveryHours: number };
  telegram: { enabled: boolean };
}
interface SettingsResponse {
  config: Config;
  env: {
    runner: string;
    bind: string;
    port: number;
    vault: string;
    accessTokenSet: boolean;
    telegramConfigured: boolean;
    codexHome: string;
    claudeHome: string;
    billingKeysPresent: string[];
  };
}

const AGENTS = [
  { value: 'claude' as const, label: 'Claude' },
  { value: 'codex' as const, label: 'Codex' },
];

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
      <div className="row-stack" style={{ flex: '1 1 220px' }}>
        <span style={{ fontWeight: 500, fontSize: 13 }}>{label}</span>
        {hint ? <span className="sub" style={{ whiteSpace: 'normal' }}>{hint}</span> : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
}

function NumberInput({ value, onChange, min, max, step = 1, suffix, label, width = 96 }: { value: number; onChange: (n: number) => void; min: number; max: number; step?: number; suffix?: string; label: string; width?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input className="input mono num" style={{ width }} type="number" inputMode="numeric" aria-label={label} min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      {suffix ? <span className="faint" style={{ fontSize: 12 }}>{suffix}</span> : null}
    </span>
  );
}

export default function Settings() {
  const res = useApi<SettingsResponse>('/api/settings');
  const [cfg, setCfg] = useState<Config | null>(null);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const theme = useTheme();

  useEffect(() => {
    if (res.data) setCfg(structuredClone(res.data.config));
  }, [res.data]);

  const dirty = cfg && res.data && JSON.stringify(cfg) !== JSON.stringify(res.data.config);
  const set = (fn: (c: Config) => void) =>
    setCfg((c) => {
      if (!c) return c;
      const n = structuredClone(c);
      fn(n);
      return n;
    });

  const save = async () => {
    if (!cfg) return;
    setSaving(true);
    setErrors([]);
    try {
      await put('/api/settings', { config: cfg });
      toast('Settings saved', { kind: 'success' });
      res.reload();
    } catch (err) {
      setErrors([(err as Error).message]);
    } finally {
      setSaving(false);
    }
  };

  const env = res.data?.env;

  return (
    <div className="page">
      <PageHead title="Settings" sub="Saved to data/config.json">
        {dirty ? (
          <>
            <button className="btn ghost" onClick={() => res.data && setCfg(structuredClone(res.data.config))}>
              Discard
            </button>
            <button className="btn primary" disabled={saving} onClick={() => void save()}>
              <Check size={14} strokeWidth={1.5} /> Save changes
            </button>
          </>
        ) : null}
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
      {errors.length ? (
        <div style={{ marginBottom: 16 }}>
          <ErrorBox error={new Error(errors.join('; '))} />
        </div>
      ) : null}
      {env?.billingKeysPresent.length ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} strokeWidth={1.5} color="var(--warning)" />
          <div>
            {env.billingKeysPresent.join(', ')} {env.billingKeysPresent.length === 1 ? 'is' : 'are'} set where Jarvis runs. Jarvis strips {env.billingKeysPresent.length === 1 ? 'it' : 'them'} from every agent, so runs still use your plan logins — but consider removing {env.billingKeysPresent.length === 1 ? 'it' : 'them'} from your shell profile.
          </div>
        </div>
      ) : null}

      {!cfg || !env ? (
        <div className="panel panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Skeleton w="40%" />
          <Skeleton w="70%" />
          <Skeleton w="55%" />
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <section className="panel">
            <div className="panel-head">
              <h2>Routing</h2>
              <span className="right faint" style={{ fontSize: 12 }}>
                explicit choice → scheduled → high effort → type
              </span>
            </div>
            {Object.keys(cfg.router.defaults).map((type) => (
              <Row key={type} label={TYPE_LABEL[type] ?? type}>
                <Segmented label={`${type} agent`} value={cfg.router.defaults[type]} options={AGENTS} onChange={(v) => set((c) => void (c.router.defaults[type] = v))} />
              </Row>
            ))}
            <Row label="High-effort tasks" hint="Big refactors, migrations and deep dives.">
              <Segmented label="High effort agent" value={cfg.router.effortOverride.high ?? 'claude'} options={AGENTS} onChange={(v) => set((c) => void (c.router.effortOverride.high = v))} />
            </Row>
            <Row label="Scheduled routines" hint="Morning brief, digests, consolidation.">
              <Segmented label="Scheduled agent" value={cfg.router.scheduledTasks} options={AGENTS} onChange={(v) => set((c) => void (c.router.scheduledTasks = v))} />
            </Row>
            <Row label="Fall back at" hint="Switch to the other agent when a plan window reaches this.">
              <NumberInput label="Fallback percent" value={cfg.router.fallbackAtPercent} min={50} max={100} suffix="%" onChange={(n) => set((c) => void (c.router.fallbackAtPercent = n))} />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Runs</h2>
            </div>
            <Row label="Concurrent runs" hint="Each agent process uses 200–400 MB. Two is the safe maximum on 8 GB.">
              <Segmented
                label="Concurrent runs"
                value={String(cfg.maxConcurrentRuns)}
                options={['1', '2', '3'].map((v) => ({ value: v, label: v }))}
                onChange={(v) => set((c) => void (c.maxConcurrentRuns = Number(v)))}
              />
            </Row>
            <Row label="Approvals expire after" hint="The task then waits in “Needs you”.">
              <NumberInput label="Approval expiry hours" value={cfg.approvals.expiryHours} min={1} max={168} suffix="hours" onChange={(n) => set((c) => void (c.approvals.expiryHours = n))} />
            </Row>
            <Row label="Learn skills from long runs" hint="After runs with many tool calls, ask the agent to propose a reusable skill.">
              <Switch label="Learning loop" checked={cfg.learning.enabled} onChange={(v) => set((c) => void (c.learning.enabled = v))} />
              <NumberInput label="Minimum tool calls" value={cfg.learning.minToolCalls} min={1} max={100} suffix="tool calls" width={72} onChange={(n) => set((c) => void (c.learning.minToolCalls = n))} />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Memory budgets</h2>
            </div>
            <Row label="Context budget per run" hint="CORE.md + project note + skill descriptions. Everything else is fetched on demand.">
              <NumberInput label="Context budget tokens" value={cfg.memory.contextBudgetTokens} min={1000} max={50000} step={500} suffix="tokens" width={110} onChange={(n) => set((c) => void (c.memory.contextBudgetTokens = n))} />
            </Row>
            <Row label="CORE.md cap" hint="Flagged on the Memory page when exceeded.">
              <NumberInput label="Core cap" value={cfg.memory.coreCapTokens} min={500} max={10000} step={100} suffix="tokens" width={110} onChange={(n) => set((c) => void (c.memory.coreCapTokens = n))} />
            </Row>
            <Row label="Project note cap">
              <NumberInput label="Project cap" value={cfg.memory.projectCapTokens} min={500} max={10000} step={100} suffix="tokens" width={110} onChange={(n) => set((c) => void (c.memory.projectCapTokens = n))} />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Usage meter</h2>
            </div>
            <Row label="Claude soft caps" hint="Used only for estimates from local transcripts when Claude hasn’t reported its own numbers.">
              <NumberInput label="Five hour token cap" value={cfg.usage.claudeSoftCaps.fiveHourTokens} min={1} max={1e9} step={100000} suffix="/ 5 h" width={130} onChange={(n) => set((c) => void (c.usage.claudeSoftCaps.fiveHourTokens = n))} />
              <NumberInput label="Weekly token cap" value={cfg.usage.claudeSoftCaps.weeklyTokens} min={1} max={1e10} step={1000000} suffix="/ week" width={130} onChange={(n) => set((c) => void (c.usage.claudeSoftCaps.weeklyTokens = n))} />
            </Row>
            <Row label="Read usage logs every">
              <NumberInput label="Poll seconds" value={cfg.usage.pollSeconds} min={30} max={3600} step={30} suffix="seconds" onChange={(n) => set((c) => void (c.usage.pollSeconds = n))} />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Appearance</h2>
            </div>
            <Row label="Theme">
              <Segmented<ThemePref>
                label="Theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'system', label: 'System' },
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                ]}
              />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Environment</h2>
              <span className="right faint" style={{ fontSize: 12 }}>
                from .env — restart Jarvis after changing
              </span>
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Runner</dt>
                <dd>{env.runner === 'mock' ? <span className="chip warn">mock — no real agent calls</span> : <span className="chip ok">real — Claude Code + Codex</span>}</dd>
                <dt>Vault</dt>
                <dd className="mono" style={{ fontSize: 12 }}>{env.vault}</dd>
                <dt>Listening</dt>
                <dd className="mono" style={{ fontSize: 12 }}>
                  {env.bind}:{env.port}
                </dd>
                <dt>Remote access</dt>
                <dd>{env.accessTokenSet ? 'On — access token required' : 'Off — localhost only (set JARVIS_BIND and JARVIS_ACCESS_TOKEN)'}</dd>
                <dt>Telegram</dt>
                <dd>{env.telegramConfigured ? 'Configured' : 'Not configured (TELEGRAM_BOT_TOKEN + TELEGRAM_ALLOWED_CHAT_ID)'}</dd>
                <dt>Codex logs</dt>
                <dd className="mono" style={{ fontSize: 12 }}>{env.codexHome}</dd>
                <dt>Claude logs</dt>
                <dd className="mono" style={{ fontSize: 12 }}>{env.claudeHome}</dd>
                <dt>API keys</dt>
                <dd>{env.billingKeysPresent.length ? `${env.billingKeysPresent.join(', ')} present — stripped from agents` : 'None set — plan logins only'}</dd>
              </dl>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
