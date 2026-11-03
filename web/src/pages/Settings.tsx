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
import { VoiceSettings } from '../components/VoiceSettings.tsx';
import { desktop } from '../lib/desktop.ts';

type Agent = 'claude' | 'codex';
interface Config {
  router: { defaults: Record<string, Agent>; effortOverride: { high?: Agent; medium?: Agent; low?: Agent }; scheduledTasks: Agent; chat: 'headroom' | Agent; fallbackAtPercent: number };
  maxConcurrentRuns: number;
  memory: { contextBudgetTokens: number; coreCapTokens: number; projectCapTokens: number };
  learning: { enabled: boolean; minToolCalls: number };
  usage: { pollSeconds: number };
  approvals: { expiryHours: number };
  classifier: { useAgent: boolean };
  feeds: { fetchEveryHours: number };
  telegram: { enabled: boolean };
  agents: Record<Agent, { model: string; chrome?: boolean; effort: Record<'low' | 'medium' | 'high', string> }>;
  collaboration: { maxConsultsPerTask: number; autoHandoffReview: boolean };
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

const EFFORTS: Record<Agent, Array<{ value: string; label: string }>> = {
  claude: [
    { value: '', label: 'Default' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
  ],
  codex: [
    { value: '', label: 'Default' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
  ],
};
const LEVELS = ['low', 'medium', 'high'] as const;

interface AnywherePrefs { enabled: boolean; shortcut: string; mode: 'ask' | 'dictate'; registered: string | null; warning: string }
const anywhere = desktop as typeof desktop & { anywhereSettings?: (patch?: Partial<AnywherePrefs>) => Promise<AnywherePrefs> };

function AnywhereSettings() {
  const [prefs, setPrefs] = useState<AnywherePrefs | null>(null);
  const [shortcut, setShortcut] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    void anywhere?.anywhereSettings?.().then((value) => { setPrefs(value); setShortcut(value.shortcut); }).catch((e: Error) => setError(e.message));
  }, []);
  if (!anywhere?.anywhereSettings) return null;
  const update = async (patch: Partial<AnywherePrefs>) => {
    setSaving(true); setError('');
    try { setPrefs(await anywhere.anywhereSettings!(patch)); }
    catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  return <section className="panel" aria-label="Jarvis anywhere">
    <div className="panel-head"><h2>Jarvis anywhere</h2><span className="faint" style={{ fontSize: 12 }}>Voice · desktop only</span></div>
    {prefs ? <>
      <Row label="Talk from any app" hint="Tap the shortcut to talk; Tab switches between Ask Jarvis and Dictate">
        <Switch label="Enable Jarvis anywhere" checked={prefs.enabled} onChange={(enabled) => { if (!saving) void update({ enabled }); }} />
      </Row>
      <Row label="Global shortcut" hint={prefs.warning || `Active shortcut: ${prefs.registered ?? 'disabled'}`}>
        <input className="input mono" style={{ width: 192 }} aria-label="Jarvis anywhere shortcut" value={shortcut} onChange={(e) => setShortcut(e.target.value)} placeholder="Control+Space" />
        <button className="btn sm" disabled={saving || shortcut === prefs.shortcut || !shortcut.trim()} onClick={() => void update({ shortcut })}>Apply</button>
      </Row>
      <Row label="Default mode" hint="Tab changes are remembered for the next time you open the overlay">
        <Segmented label="Jarvis anywhere mode" value={prefs.mode} options={[{ value: 'ask', label: 'Ask Jarvis' }, { value: 'dictate', label: 'Dictate' }]} onChange={(mode) => { if (!saving) void update({ mode }); }} />
      </Row>
    </> : <div className="panel-body"><Skeleton w="60%" /></div>}
    {error ? <div className="panel-body" role="alert">{error}</div> : null}
  </section>;
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
            <Row label="Questions on Ask" hint="Plain questions go to the plan with more room left, or always to one agent">
              <Segmented label="Questions on Ask" value={cfg.router.chat} options={[{ value: 'headroom', label: 'More room' }, ...AGENTS]} onChange={(v) => set((c) => void (c.router.chat = v))} />
            </Row>
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
              <h2>Agents</h2>
              <span className="right faint" style={{ fontSize: 12 }}>
                each runs in its own official harness
              </span>
            </div>
            {(['claude', 'codex'] as const).map((a) => (
              <div key={a}>
                <Row
                  label={a === 'claude' ? 'Claude Code' : 'Codex'}
                  hint={a === 'claude' ? 'Model alias or id (e.g. opus, sonnet). Empty uses your Claude Code default.' : 'Model id (e.g. gpt-5-codex). Empty uses your Codex default.'}
                >
                  <input
                    className="input mono"
                    style={{ width: 200 }}
                    aria-label={`${a} model`}
                    placeholder="Plan default"
                    value={cfg.agents[a].model}
                    onChange={(e) => set((c) => void (c.agents[a].model = e.target.value.trim()))}
                  />
                </Row>
                <Row label="Reasoning effort by task effort" hint="How hard the agent thinks for low, medium and high effort tasks. Higher uses more of your plan.">
                  {LEVELS.map((lvl) => (
                    <label key={lvl} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span className="faint" style={{ textTransform: 'capitalize' }}>{lvl}</span>
                      <select
                        className="input"
                        aria-label={`${a} effort for ${lvl} tasks`}
                        value={cfg.agents[a].effort[lvl]}
                        onChange={(e) => set((c) => void (c.agents[a].effort[lvl] = e.target.value))}
                        style={{ width: 118 }}
                      >
                        {EFFORTS[a].map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </Row>
              </div>
            ))}
            <Row label="Claude can use your Chrome" hint="Claude in Chrome extension; you approve sites in the extension">
              <Switch label="Claude can use your Chrome" checked={cfg.agents.claude.chrome ?? false} onChange={(chrome) => set((c) => void (c.agents.claude.chrome = chrome))} />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Collaboration</h2>
            </div>
            <Row label="Consults per task" hint="How many times an agent may ask the other one for a second opinion mid-task (consult_agent tool). 0 turns it off.">
              <Segmented
                label="Consults per task"
                value={String(cfg.collaboration.maxConsultsPerTask)}
                options={['0', '1', '2', '3', '5'].map((v) => ({ value: v, label: v }))}
                onChange={(v) => set((c) => void (c.collaboration.maxConsultsPerTask = Number(v)))}
              />
            </Row>
            <Row label="Cross-review code tasks" hint="When a code task finishes, hand it to the other agent for a read-only review automatically.">
              <Switch label="Cross-review code tasks" checked={cfg.collaboration.autoHandoffReview} onChange={(v) => set((c) => void (c.collaboration.autoHandoffReview = v))} />
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
            <Row label="Read usage logs every">
              <NumberInput label="Poll seconds" value={cfg.usage.pollSeconds} min={30} max={3600} step={30} suffix="seconds" onChange={(n) => set((c) => void (c.usage.pollSeconds = n))} />
            </Row>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Notifications and feeds</h2>
            </div>
            <Row label="Telegram bot" hint={env.telegramConfigured ? 'Approvals with buttons, finished tasks, the morning brief. Text it to create tasks.' : 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_CHAT_ID in .env, then restart.'}>
              <Switch label="Telegram bot" checked={cfg.telegram.enabled} disabled={!env.telegramConfigured} onChange={(v) => set((c) => void (c.telegram.enabled = v))} />
            </Row>
            <Row label="Check feeds every" hint="Plain HTTP fetches — no agent, no plan usage.">
              <NumberInput label="Feed interval hours" value={cfg.feeds.fetchEveryHours} min={1} max={72} suffix="hours" width={72} onChange={(n) => set((c) => void (c.feeds.fetchEveryHours = n))} />
            </Row>
          </section>

          <VoiceSettings />
          <AnywhereSettings />

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
