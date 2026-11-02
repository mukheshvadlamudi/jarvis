import { Check, Eye, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorBox, Link, PageHead, Sheet, Skeleton, SkeletonRows, Switch, TextArea, TextInput } from '../components/ui.tsx';
import { patch, post } from '../lib/api.ts';
import { relTime } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import { Markdown } from '../lib/markdown.tsx';
import { setQuery, useLocation } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';

type SyncState = 'add' | 'update' | 'remove' | 'unchanged' | 'skip';
interface Skill {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: number;
  updated_at: string;
  synced_at: string | null;
  sync: Record<'claude' | 'codex', SyncState> | null;
}
interface SkillsResponse {
  skills: Skill[];
  targets: Record<'claude' | 'codex', string>;
  dryRunTargets: boolean;
  pendingProposals: number;
  templates: Array<{ name: string; description: string; exists: boolean }>;
}
interface Proposal {
  id: string;
  run_id: string | null;
  name: string;
  description: string;
  body: string;
  status: string;
  created_at: string;
  existing: number;
}
interface SyncResult {
  dryRun: boolean;
  actions: Array<{ target: 'claude' | 'codex'; skill: string; action: SyncState; reason?: string }>;
}

function SyncChip({ agent, state, enabled }: { agent: string; state: SyncState | undefined; enabled: boolean }) {
  if (!enabled) return <span className="chip">{agent}: off</span>;
  if (!state || state === 'unchanged') return <span className="chip ok">{agent}: synced</span>;
  if (state === 'skip') return <span className="chip danger" title="A skill with this name exists that Jarvis did not create; it is left alone.">{agent}: name taken</span>;
  return <span className="chip warn">{agent}: {state === 'add' ? 'not synced' : 'out of date'}</span>;
}

function ProposalCard({ p, onDone }: { p: Proposal; onDone: () => void }) {
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [body, setBody] = useState(p.body);
  const [busy, setBusy] = useState(false);
  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      await post(`/api/skills/proposals/${p.id}`, decision === 'approved' ? { decision, name, description, body } : { decision });
      toast(decision === 'approved' ? `Saved Skills/${name}/SKILL.md and synced it` : 'Proposal rejected', { kind: 'success' });
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="approval">
      <div className="approval-meta">
        <span className="chip accent">{p.existing ? 'Update to existing skill' : 'New skill'}</span>
        <span className="mono">{relTime(p.created_at)}</span>
        {p.run_id ? (
          <Link to={`/runs/${p.run_id}`} className="faint">
            learned from this run →
          </Link>
        ) : null}
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor={`n-${p.id}`}>Name</label>
          <TextInput id={`n-${p.id}`} value={name} onValue={setName} mic={false} className="mono" />
        </div>
        <div className="field">
          <label htmlFor={`d-${p.id}`}>When to use it</label>
          <TextInput id={`d-${p.id}`} value={description} onValue={setDescription} />
        </div>
        <div className="field full">
          <label htmlFor={`b-${p.id}`}>SKILL.md</label>
          <TextArea id={`b-${p.id}`} value={body} onValue={setBody} className="mono" rows={8} style={{ fontSize: 12 }} />
        </div>
      </div>
      <div className="approval-actions">
        <span style={{ flex: 1 }} />
        <button className="btn ghost" disabled={busy} onClick={() => void decide('rejected')}>
          Reject
        </button>
        <button className="btn primary" disabled={busy || !name.trim() || !body.trim()} onClick={() => void decide('approved')}>
          Approve and save
        </button>
      </div>
    </div>
  );
}

export default function Skills() {
  const { query } = useLocation();
  const open = query.get('skill');
  const res = useApi<SkillsResponse>('/api/skills', ['skills.updated', 'memory.updated']);
  const proposals = useApi<{ proposals: Proposal[] }>('/api/skills/proposals?status=pending', ['skills.updated']);
  const [result, setResult] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const d = res.data;
  const outOfSync = d?.skills.filter((s) => s.enabled && s.sync && (['add', 'update'].includes(s.sync.claude) || ['add', 'update'].includes(s.sync.codex))).length ?? 0;

  const sync = async (dryRun: boolean) => {
    setSyncing(true);
    try {
      const r = await post<SyncResult>('/api/skills/sync', { dryRun });
      setResult(r);
      const changes = r.actions.filter((a) => !['unchanged'].includes(a.action)).length;
      toast(dryRun ? `Preview: ${changes} change${changes === 1 ? '' : 's'}` : changes ? `Synced — ${changes} change${changes === 1 ? '' : 's'}` : 'Already in sync', { kind: 'success' });
    } catch (err) {
      toastError(err);
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="page">
      <PageHead title="Skills" sub={d ? `${d.skills.filter((s) => s.enabled).length} enabled · ${outOfSync ? `${outOfSync} need syncing` : 'all synced'}` : undefined}>
        <button className="btn" disabled={syncing} onClick={() => void sync(true)}>
          <Eye size={14} strokeWidth={1.5} /> Preview sync
        </button>
        <button className="btn primary" disabled={syncing} onClick={() => void sync(false)}>
          <RefreshCw size={14} strokeWidth={1.5} className={syncing ? 'spin' : undefined} /> Sync now
        </button>
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}

      {proposals.data?.proposals.length ? (
        <section className="panel" style={{ marginBottom: 24, borderColor: 'var(--accent)' }}>
          <div className="panel-head">
            <h2>Proposed by agents</h2>
            <span className="count">{proposals.data.proposals.length}</span>
            <span className="right faint hide-sm" style={{ fontSize: 12 }}>
              Edit before approving if you like
            </span>
          </div>
          {proposals.data.proposals.map((p) => (
            <ProposalCard key={p.id} p={p} onDone={proposals.reload} />
          ))}
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Vault skills</h2>
          <span className="count">{d?.skills.length ?? ''}</span>
          <span className="right faint mono hide-sm" style={{ fontSize: 12 }}>
            Skills/&lt;name&gt;/SKILL.md
          </span>
        </div>
        {res.loading ? <SkeletonRows rows={5} /> : null}
        {d && !d.skills.length ? <Empty title="No skills in your vault yet">Add Skills/&lt;name&gt;/SKILL.md with name and description frontmatter, or start from a connector template below.</Empty> : null}
        <ul className="list">
          {d?.skills.map((s) => (
            <li key={s.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <Switch
                label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
                checked={!!s.enabled}
                onChange={async (v) => {
                  try {
                    await patch(`/api/skills/${s.name}`, { enabled: v });
                    res.reload();
                  } catch (err) {
                    toastError(err);
                  }
                }}
              />
              <button className="row-stack" style={{ background: 'none', border: 0, padding: 0, textAlign: 'left', cursor: 'pointer', flex: '1 1 240px' }} onClick={() => setQuery({ skill: s.name })}>
                <span className="title mono" style={{ fontSize: 13 }}>
                  {s.name}
                </span>
                <span className="sub" style={{ whiteSpace: 'normal' }}>
                  {s.description || 'No description — agents only see the name.'}
                </span>
              </button>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <SyncChip agent="Claude" state={s.sync?.claude} enabled={!!s.enabled} />
                <SyncChip agent="Codex" state={s.sync?.codex} enabled={!!s.enabled} />
              </span>
            </li>
          ))}
        </ul>
      </section>

      {result ? (
        <section className="panel" style={{ marginTop: 24 }}>
          <div className="panel-head">
            <h2>{result.dryRun ? 'Sync preview' : 'Last sync'}</h2>
            <span className="right">
              <button className="btn sm ghost" onClick={() => setResult(null)}>
                Dismiss
              </button>
            </span>
          </div>
          <ul className="list">
            {result.actions.filter((a) => a.action !== 'unchanged').length === 0 ? <Empty title="Nothing to change" /> : null}
            {result.actions
              .filter((a) => a.action !== 'unchanged')
              .map((a, i) => (
                <li key={i} className="row">
                  <span className={`chip ${a.action === 'remove' ? 'danger' : a.action === 'skip' ? '' : 'ok'}`}>{a.action}</span>
                  <span className="title mono" style={{ fontSize: 12, fontWeight: 400 }}>
                    {a.target === 'claude' ? d?.targets.claude : d?.targets.codex}/{a.skill}
                  </span>
                  {a.reason ? <span className="faint hide-sm" style={{ fontSize: 12 }}>{a.reason}</span> : null}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      <div className="grid-2" style={{ marginTop: 24 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>Connector templates</h2>
          </div>
          <ul className="list">
            {d?.templates.map((t) => (
              <li key={t.name} className="row">
                <div className="row-stack">
                  <span className="title mono" style={{ fontSize: 13 }}>
                    {t.name}
                  </span>
                  <span className="sub" style={{ whiteSpace: 'normal' }}>
                    {t.description}
                  </span>
                </div>
                {t.exists ? (
                  <span className="chip ok">
                    <Check size={12} /> in vault
                  </span>
                ) : (
                  <button
                    className="btn sm"
                    onClick={async () => {
                      try {
                        await post(`/api/skills/templates/${t.name}`);
                        toast(`Created Skills/${t.name}/SKILL.md — edit it in Obsidian`, { kind: 'success' });
                        res.reload();
                      } catch (err) {
                        toastError(err);
                      }
                    }}
                  >
                    <Plus size={14} strokeWidth={1.5} /> Add
                  </button>
                )}
              </li>
            )) ?? <SkeletonRows rows={4} />}
          </ul>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Where they go</h2>
          </div>
          <div className="panel-body">
            {d ? (
              <dl className="kv">
                <dt>Claude</dt>
                <dd className="mono" style={{ fontSize: 12 }}>{d.targets.claude}</dd>
                <dt>Codex</dt>
                <dd className="mono" style={{ fontSize: 12 }}>{d.targets.codex}</dd>
              </dl>
            ) : (
              <Skeleton />
            )}
            <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
              Copied, not linked (Windows-safe). A manifest records which skills Jarvis created, so skills you installed yourself are never touched.
              {d?.dryRunTargets ? ' Mock mode writes to a dry-run folder under data/, not your real home folders.' : ''}
            </p>
          </div>
        </section>
      </div>

      {open ? <SkillSheet name={open} onClose={() => setQuery({ skill: null })} /> : null}
    </div>
  );
}

function SkillSheet({ name, onClose }: { name: string; onClose: () => void }) {
  const res = useApi<{ skill: Skill; content: string | null }>(`/api/skills/${encodeURIComponent(name)}`, ['skills.updated']);
  const body = res.data?.content?.replace(/^---[\s\S]*?\n---\s*\n?/, '') ?? '';
  return (
    <Sheet title={name} onClose={onClose}>
      {res.error ? <ErrorBox error={res.error} /> : null}
      {!res.data ? (
        <Skeleton />
      ) : (
        <>
          <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
            {res.data.skill.description}
          </p>
          <p className="mono faint" style={{ fontSize: 12, marginBottom: 16 }}>
            {res.data.skill.path} · {res.data.skill.synced_at ? `synced ${relTime(res.data.skill.synced_at)}` : 'never synced'}
          </p>
          <Markdown source={body} />
        </>
      )}
    </Sheet>
  );
}
