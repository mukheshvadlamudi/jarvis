import { Pencil, Play, Plus, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Empty, ErrorBox, Link, PageHead, Sheet, SkeletonRows, StatusLabel, Switch, TextArea, TextInput } from '../components/ui.tsx';
import { del, patch, post } from '../lib/api.ts';
import { describeCron } from '../lib/cron.ts';
import { dateTime, relTime, TYPE_LABEL } from '../lib/format.ts';
import { useApi, useNow } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Project, TaskType } from '../lib/types.ts';

interface Template {
  title: string;
  body?: string;
  type?: TaskType;
  agent_pref?: 'auto' | 'claude' | 'codex';
  project_id?: string | null;
  routine?: string;
}
interface Schedule {
  id: string;
  name: string;
  cron: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  built_in: string | null;
  description: string;
  template: Template;
  upcoming: string[];
  lastRun: { kind: string; ts: string; task_id: string | null; note: string | null } | null;
}
interface HistoryRow {
  id: number;
  schedule_id: string;
  name: string;
  ts: string;
  due_at: string | null;
  kind: 'scheduled' | 'manual' | 'missed' | 'skipped' | 'failed';
  task_id: string | null;
  task_status: string | null;
  task_title: string | null;
  note: string | null;
}

const KIND_LABEL: Record<HistoryRow['kind'], string> = { scheduled: 'On time', manual: 'Run now', missed: 'Caught up', skipped: 'Skipped', failed: 'Failed' };

function ScheduleRow({ s, now, onEdit, reload }: { s: Schedule; now: number; onEdit: () => void; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <li className="row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <Switch
        label={`${s.enabled ? 'Disable' : 'Enable'} ${s.name}`}
        checked={!!s.enabled}
        onChange={async (v) => {
          try {
            await patch(`/api/schedules/${s.id}`, { enabled: v });
            toast(v ? `${s.name} is on — next ${describeCron(s.cron).toLowerCase()}` : `${s.name} is off`, { kind: 'success' });
            reload();
          } catch (err) {
            toastError(err);
          }
        }}
      />
      <div className="row-stack" style={{ flex: '1 1 260px' }}>
        <span className="title">{s.name}</span>
        <span className="sub" style={{ whiteSpace: 'normal' }}>
          <span className="mono" style={{ fontSize: 12 }}>{describeCron(s.cron)}</span>
          {s.description ? ` · ${s.description}` : s.template.type ? ` · ${TYPE_LABEL[s.template.type]}` : ''}
        </span>
      </div>
      <div className="meta" style={{ flexWrap: 'wrap' }}>
        <span className="mono" style={{ fontSize: 12, minWidth: 110, textAlign: 'right' }} title={s.next_run_at ? dateTime(s.next_run_at) : undefined}>
          {s.enabled && s.next_run_at ? `next ${relTime(s.next_run_at, now)}` : s.enabled ? '' : 'off'}
        </span>
        <button
          className="btn sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await post<{ task: { id: string; title: string } }>(`/api/schedules/${s.id}/run-now`);
              toast(`Queued “${r.task.title}”`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${r.task.id}`) } });
            } catch (err) {
              toastError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Play size={12} strokeWidth={1.5} /> Run now
        </button>
        <button className="btn sm ghost icon" aria-label={`Edit ${s.name}`} onClick={onEdit}>
          <Pencil size={14} strokeWidth={1.5} />
        </button>
      </div>
    </li>
  );
}

function Editor({ initial, presets, projects, onClose, onSaved }: { initial: Schedule | null; presets: Array<{ label: string; cron: string }>; projects: Project[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [cron, setCron] = useState(initial?.cron ?? '0 9 * * 1');
  const [words, setWords] = useState('');
  const [title, setTitle] = useState(initial?.template.title ?? '');
  const [body, setBody] = useState(initial?.template.body ?? '');
  const [type, setType] = useState<TaskType | ''>(initial?.template.type ?? '');
  const [agent, setAgent] = useState(initial?.template.agent_pref ?? 'auto');
  const [project, setProject] = useState(initial?.template.project_id ?? '');
  const [check, setCheck] = useState<{ ok: boolean; error: string | null; upcoming: string[] } | null>(null);
  const [converting, setConverting] = useState(false);
  const [saving, setSaving] = useState(false);
  const builtIn = !!initial?.built_in;

  useEffect(() => {
    const t = window.setTimeout(() => {
      post<{ ok: boolean; error: string | null; upcoming: string[] }>('/api/schedules/validate', { cron }).then(setCheck).catch(() => undefined);
    }, 200);
    return () => window.clearTimeout(t);
  }, [cron]);

  const save = async () => {
    setSaving(true);
    const template: Template = builtIn ? { ...initial!.template } : { title: title.trim(), body: body.trim(), type: type || undefined, agent_pref: agent, project_id: project || null };
    try {
      if (initial) await patch(`/api/schedules/${initial.id}`, { name, cron, template });
      else await post('/api/schedules', { name, cron, template });
      toast(initial ? 'Schedule saved' : 'Schedule created and turned on', { kind: 'success' });
      onSaved();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={initial ? `Edit ${initial.name}` : 'New schedule'}
      onClose={onClose}
      footer={
        <>
          {initial && !builtIn ? (
            <button
              className="btn ghost danger"
              onClick={async () => {
                if (!confirm(`Delete “${initial.name}”? Its run history goes too.`)) return;
                try {
                  await del(`/api/schedules/${initial.id}`);
                  onSaved();
                  onClose();
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              <Trash2 size={14} strokeWidth={1.5} /> Delete
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving || !name.trim() || !check?.ok || (!builtIn && !title.trim())} onClick={() => void save()}>
            {initial ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="sch-name">Name</label>
          <TextInput id="sch-name" value={name} onValue={setName} placeholder="e.g. Chase unpaid invoices" />
        </div>
        <div className="field full">
          <label htmlFor="sch-words">Describe when</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{ flex: 1 }}>
              <TextInput id="sch-words" value={words} onValue={setWords} placeholder="weekdays at 8:30, every 4 hours, on the 1st at 9…" />
            </div>
            <button
              className="btn"
              disabled={!words.trim() || converting}
              onClick={async () => {
                setConverting(true);
                try {
                  const r = await post<{ cron: string | null; via: string; error?: string }>('/api/schedules/parse', { text: words });
                  if (r.cron) {
                    setCron(r.cron);
                    toast(r.via === 'rules' ? 'Converted (no agent call needed)' : 'Converted with one small Codex call', { kind: 'success' });
                  } else toast(r.error ?? 'Could not convert that.', { kind: 'error' });
                } catch (err) {
                  toastError(err);
                } finally {
                  setConverting(false);
                }
              }}
            >
              <Wand2 size={14} strokeWidth={1.5} /> Convert
            </button>
          </div>
          <span className="hint">Common phrasings convert locally; anything unusual uses one small Codex call, only when you press Convert.</span>
        </div>
        <div className="field">
          <label htmlFor="sch-preset">Preset</label>
          <select id="sch-preset" className="select" value={presets.find((p) => p.cron === cron)?.cron ?? ''} onChange={(e) => e.target.value && setCron(e.target.value)}>
            <option value="">Custom</option>
            {presets.map((p) => (
              <option key={p.cron} value={p.cron}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="sch-cron">Cron</label>
          <input id="sch-cron" className="input mono" value={cron} onChange={(e) => setCron(e.target.value)} spellCheck={false} />
        </div>
        <div className="field full" aria-live="polite">
          {check?.ok ? (
            <span className="hint">
              {describeCron(cron)} · next: {check.upcoming.map((u) => dateTime(u)).join(', ')}
            </span>
          ) : check?.error ? (
            <span className="hint" style={{ color: 'var(--danger)' }}>
              {check.error}
            </span>
          ) : null}
        </div>
        {builtIn ? (
          <p className="faint full" style={{ fontSize: 12 }}>
            Built-in routine: Jarvis writes the prompt at run time from live state (tasks, usage, follow-ups, feeds). You can change the name and the time.
          </p>
        ) : (
          <>
            <div className="field full">
              <label htmlFor="sch-title">Task title</label>
              <TextInput id="sch-title" value={title} onValue={setTitle} placeholder="What the agent should do each time" />
            </div>
            <div className="field full">
              <label htmlFor="sch-body">Details</label>
              <TextArea id="sch-body" value={body} onValue={setBody} rows={4} placeholder="Instructions, links, what “done” looks like" />
            </div>
            <div className="field">
              <label htmlFor="sch-type">Type</label>
              <select id="sch-type" className="select" value={type} onChange={(e) => setType(e.target.value as TaskType | '')}>
                <option value="">Detect from title</option>
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="sch-agent">Agent</label>
              <select id="sch-agent" className="select" value={agent} onChange={(e) => setAgent(e.target.value as 'auto' | 'claude' | 'codex')}>
                <option value="auto">Scheduled default (Settings)</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div className="field full">
              <label htmlFor="sch-project">Project</label>
              <select id="sch-project" className="select" value={project ?? ''} onChange={(e) => setProject(e.target.value)}>
                <option value="">None</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}

export default function Schedules() {
  const res = useApi<{ schedules: Schedule[]; presets: Array<{ label: string; cron: string }> }>('/api/schedules', ['schedule.*']);
  const hist = useApi<{ runs: HistoryRow[] }>('/api/schedules/history?limit=30', ['schedule.*', 'task.updated']);
  const projects = useApi<{ projects: Project[] }>('/api/projects');
  const [editing, setEditing] = useState<Schedule | 'new' | null>(null);
  const now = useNow();
  const builtIns = (res.data?.schedules ?? []).filter((s) => s.built_in);
  const custom = (res.data?.schedules ?? []).filter((s) => !s.built_in);
  const on = (res.data?.schedules ?? []).filter((s) => s.enabled).length;

  return (
    <div className="page">
      <PageHead title="Schedules" sub={res.data ? `${on} on · ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : undefined}>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={14} strokeWidth={1.5} /> New schedule
        </button>
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Routines</h2>
          <span className="right faint hide-sm" style={{ fontSize: 12 }}>
            Off until you turn them on · run on Codex by default
          </span>
        </div>
        {res.loading ? <SkeletonRows rows={5} /> : null}
        <ul className="list">
          {builtIns.map((s) => (
            <ScheduleRow key={s.id} s={s} now={now} onEdit={() => setEditing(s)} reload={res.reload} />
          ))}
        </ul>
      </section>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2>Your schedules</h2>
          <span className="count">{custom.length}</span>
        </div>
        {!res.loading && !custom.length ? (
          <Empty title="No custom schedules yet" action={<button className="btn" onClick={() => setEditing('new')}><Plus size={14} strokeWidth={1.5} /> New schedule</button>}>
            Recurring tasks like “chase unpaid invoices on the 15th” — each run creates a task you can watch and review.
          </Empty>
        ) : null}
        <ul className="list">
          {custom.map((s) => (
            <ScheduleRow key={s.id} s={s} now={now} onEdit={() => setEditing(s)} reload={res.reload} />
          ))}
        </ul>
      </section>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2>History</h2>
          <span className="right faint hide-sm" style={{ fontSize: 12 }}>
            Missed while asleep: run once if under 12 h late, otherwise skipped
          </span>
        </div>
        {hist.loading ? <SkeletonRows rows={3} /> : null}
        {!hist.loading && !hist.data?.runs.length ? <Empty title="Nothing has run yet">Use “Run now” to try a schedule immediately.</Empty> : null}
        <ul className="list">
          {(hist.data?.runs ?? []).map((r) => (
            <li key={r.id}>
              {r.task_id ? (
                <Link to={`/tasks/${r.task_id}`} className="row">
                  <span className={`chip ${r.kind === 'missed' ? 'warn' : r.kind === 'failed' ? 'danger' : ''}`}>{KIND_LABEL[r.kind]}</span>
                  <div className="row-stack">
                    <span className="title">{r.task_title ?? r.name}</span>
                    {r.note ? <span className="sub">{r.note}</span> : null}
                  </div>
                  <span className="meta">
                    {r.task_status ? <StatusLabel status={r.task_status} /> : null}
                    <span className="time">{relTime(r.ts, now)}</span>
                  </span>
                </Link>
              ) : (
                <div className="row">
                  <span className={`chip ${r.kind === 'failed' ? 'danger' : ''}`}>{KIND_LABEL[r.kind]}</span>
                  <div className="row-stack">
                    <span className="title">{r.name}</span>
                    {r.note ? <span className="sub">{r.note}</span> : null}
                  </div>
                  <span className="time">{relTime(r.ts, now)}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      {editing ? (
        <Editor
          initial={editing === 'new' ? null : editing}
          presets={res.data?.presets ?? []}
          projects={projects.data?.projects ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            res.reload();
            hist.reload();
          }}
        />
      ) : null}
    </div>
  );
}
