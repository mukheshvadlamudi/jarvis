import { ExternalLink, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { AgentBadge, Empty, ErrorBox, Link, PageHead, Segmented, Sheet, Skeleton, StatusLabel } from '../components/ui.tsx';
import { del, patch, post } from '../lib/api.ts';
import { dateTime, relTime, shortAge, STATUS_LABEL, TYPE_LABEL } from '../lib/format.ts';
import { useApi, useMedia, useNow } from '../lib/hooks.ts';
import { navigate, setQuery, useLocation } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Project, Task, TaskStatus } from '../lib/types.ts';

type ColumnKey = 'inbox' | 'queued' | 'running' | 'needs_you' | 'done';
const COLUMNS: Array<{ key: ColumnKey; label: string; statuses: TaskStatus[]; hint: string }> = [
  { key: 'inbox', label: 'Inbox', statuses: ['inbox'], hint: 'Captured, not started. Drag to Queued to run.' },
  { key: 'queued', label: 'Queued', statuses: ['queued'], hint: 'Starts when one of the 2 slots frees up.' },
  { key: 'running', label: 'Running', statuses: ['running'], hint: 'Agents working now.' },
  { key: 'needs_you', label: 'Needs you', statuses: ['needs_you'], hint: 'Paused for an approval or a decision.' },
  { key: 'done', label: 'Done', statuses: ['done', 'failed', 'cancelled'], hint: 'Finished, failed or cancelled.' },
];

/** Target status when a card is dropped on a column. */
function dropTarget(col: ColumnKey): TaskStatus | null {
  if (col === 'inbox') return 'inbox';
  if (col === 'queued' || col === 'running') return 'queued';
  if (col === 'done') return 'done';
  return null;
}

async function moveTask(t: Task, col: ColumnKey) {
  const to = dropTarget(col);
  if (!to) {
    toast('Tasks move to “Needs you” on their own when an agent pauses.', { kind: 'info' });
    return;
  }
  const from = COLUMNS.find((c) => c.statuses.includes(t.status))?.key;
  if (from === col) return;
  try {
    if (to === 'queued') await post(`/api/tasks/${t.id}/run`);
    else await patch(`/api/tasks/${t.id}`, { status: to });
    toast(`Moved to ${STATUS_LABEL[to]}`, {
      kind: 'success',
      action: from === 'inbox' || from === 'queued' ? { label: 'Undo', run: () => void patch(`/api/tasks/${t.id}`, { status: from === 'inbox' ? 'inbox' : 'queued' }).catch(toastError) } : undefined,
    });
  } catch (err) {
    toastError(err);
  }
}

function TaskCard({ t, selected, now, onSelect }: { t: Task; selected: boolean; now: number; onSelect: () => void }) {
  const [dragging, setDragging] = useState(false);
  return (
    <div
      className={`card-row${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      draggable
      tabIndex={0}
      role="button"
      aria-label={`${t.title}, ${STATUS_LABEL[t.status]}`}
      data-task={t.id}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/x-task', t.id);
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => setDragging(false)}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <span className="title">{t.title}</span>
      <span className="meta">
        {t.status === 'failed' || t.status === 'cancelled' ? <StatusLabel status={t.status} /> : null}
        {t.agent || t.agent_pref !== 'auto' ? <AgentBadge agent={t.agent ?? (t.agent_pref as 'claude' | 'codex')} reason={t.route_reason} /> : null}
        <span>{TYPE_LABEL[t.type]}</span>
        <span className="mono" style={{ marginLeft: 'auto' }}>{shortAge(t.updated_at, now)}</span>
      </span>
    </div>
  );
}

export default function Board() {
  const { query } = useLocation();
  const project = query.get('project') ?? '';
  const type = query.get('type') ?? '';
  const agent = query.get('agent') ?? '';
  const selectedId = query.get('task');
  // Conversations live on Ask; the Board is for background tasks.
  const params = new URLSearchParams({ limit: '400', mode: 'task' });
  if (project) params.set('project', project);
  if (type) params.set('type', type);
  if (agent) params.set('agent', agent);
  const tasks = useApi<{ tasks: Task[]; counts: Record<string, number> }>(`/api/tasks?${params}`, ['task.*', 'run.finished']);
  const projects = useApi<{ projects: Project[] }>('/api/projects', ['project.*']);
  const [over, setOver] = useState<ColumnKey | null>(null);
  const [mobileCol, setMobileCol] = useState<ColumnKey>('running');
  const desktop = useMedia('(min-width: 1024px)');
  const now = useNow();

  const byCol = useMemo(() => {
    const out = Object.fromEntries(COLUMNS.map((c) => [c.key, [] as Task[]])) as Record<ColumnKey, Task[]>;
    for (const t of tasks.data?.tasks ?? []) {
      const col = COLUMNS.find((c) => c.statuses.includes(t.status));
      if (col) out[col.key].push(t);
    }
    out.done = out.done.slice(0, 60);
    return out;
  }, [tasks.data]);

  const flat = useMemo(() => COLUMNS.flatMap((c) => byCol[c.key]), [byCol]);
  const selected = flat.find((t) => t.id === selectedId) ?? null;
  const select = (t: Task | null) => {
    if (t && !desktop) navigate(`/tasks/${t.id}`);
    else setQuery({ task: t?.id ?? null });
  };

  // j/k move the selection; [ and ] move the selected card between columns (keyboard alternative to drag).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.querySelector('.sheet, .palette') && e.key !== 'Escape') return;
      const idx = selected ? flat.indexOf(selected) : -1;
      if (e.key === 'j' || e.key === 'k') {
        e.preventDefault();
        const next = flat[Math.max(0, Math.min(flat.length - 1, idx + (e.key === 'j' ? 1 : -1)))];
        if (next) {
          setQuery({ task: next.id });
          document.querySelector<HTMLElement>(`[data-task="${next.id}"]`)?.focus();
        }
      } else if ((e.key === '[' || e.key === ']') && selected) {
        const col = COLUMNS.findIndex((c) => c.statuses.includes(selected.status));
        const target = COLUMNS[col + (e.key === ']' ? 1 : -1)];
        if (target) void moveTask(selected, target.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flat, selected]);

  const onDrop = (col: ColumnKey) => (e: DragEvent) => {
    e.preventDefault();
    setOver(null);
    const id = e.dataTransfer.getData('text/x-task');
    const t = flat.find((x) => x.id === id);
    if (t) void moveTask(t, col);
  };

  const filters = (
    <>
      <select className="select" style={{ width: 'auto', minWidth: 140 }} aria-label="Filter by project" value={project} onChange={(e) => setQuery({ project: e.target.value })}>
        <option value="">All projects</option>
        {(projects.data?.projects ?? []).map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select className="select" style={{ width: 'auto', minWidth: 120 }} aria-label="Filter by type" value={type} onChange={(e) => setQuery({ type: e.target.value })}>
        <option value="">All types</option>
        {Object.entries(TYPE_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
      <select className="select" style={{ width: 'auto', minWidth: 120 }} aria-label="Filter by agent" value={agent} onChange={(e) => setQuery({ agent: e.target.value })}>
        <option value="">Any agent</option>
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
    </>
  );

  return (
    <div className="page wide">
      <PageHead title="Board" sub={<span className="hide-sm">Drag cards between columns, or select one and press <kbd>[</kbd> <kbd>]</kbd></span>}>
        {filters}
      </PageHead>
      {tasks.error ? <ErrorBox error={tasks.error} onRetry={tasks.reload} /> : null}

      <div className="board" aria-label="Task board">
        {COLUMNS.map((c) => (
          <section
            key={c.key}
            className={`column${over === c.key ? ' drop' : ''}`}
            aria-label={c.label}
            onDragOver={(e) => {
              if (dropTarget(c.key)) {
                e.preventDefault();
                setOver(c.key);
              }
            }}
            onDragLeave={() => setOver((o) => (o === c.key ? null : o))}
            onDrop={onDrop(c.key)}
          >
            <div className="column-head" title={c.hint}>
              {c.key === 'running' ? <span className="dot live" /> : null}
              {c.label}
              <span className="count">{tasks.data ? byCol[c.key].length : ''}</span>
            </div>
            <div className="column-body">
              {tasks.loading ? (
                <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
                  <Skeleton w="85%" />
                  <Skeleton w="60%" h={10} />
                  <Skeleton w="75%" />
                </div>
              ) : byCol[c.key].length === 0 ? (
                <div className="empty" style={{ padding: 12, fontSize: 12 }}>
                  {c.hint}
                </div>
              ) : (
                byCol[c.key].map((t) => <TaskCard key={t.id} t={t} now={now} selected={t.id === selectedId} onSelect={() => select(t)} />)
              )}
            </div>
          </section>
        ))}
      </div>

      <div className="board-mobile">
        <div style={{ marginBottom: 12, maxWidth: '100%', overflowX: 'auto' }}>
          <Segmented
            label="Column"
            value={mobileCol}
            onChange={setMobileCol}
            options={COLUMNS.map((c) => ({ value: c.key, label: `${c.label} ${tasks.data ? byCol[c.key].length : ''}` }))}
          />
        </div>
        <div className="panel">
          {tasks.loading ? (
            <div style={{ padding: 16 }}>
              <Skeleton w="80%" />
            </div>
          ) : byCol[mobileCol].length === 0 ? (
            <Empty title={`Nothing in ${COLUMNS.find((c) => c.key === mobileCol)!.label}.`}>{COLUMNS.find((c) => c.key === mobileCol)!.hint}</Empty>
          ) : (
            <ul className="list">
              {byCol[mobileCol].map((t) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`} className="row">
                    <div className="row-stack">
                      <span className="title">{t.title}</span>
                      <span className="sub" style={{ display: 'flex', gap: 8 }}>
                        <AgentBadge agent={t.agent} reason={t.route_reason} />
                        {TYPE_LABEL[t.type]}
                      </span>
                    </div>
                    <span className="time">{shortAge(t.updated_at, now)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {selected && desktop ? <TaskSheet t={selected} projects={projects.data?.projects ?? []} onClose={() => setQuery({ task: null })} /> : null}
    </div>
  );
}

function TaskSheet({ t, projects, onClose }: { t: Task; projects: Project[]; onClose: () => void }) {
  const project = projects.find((p) => p.id === t.project_id);
  const canRun = !['running', 'needs_you'].includes(t.status);
  const run = async (agentPref: 'claude' | 'codex' | 'auto') => {
    try {
      await post(`/api/tasks/${t.id}/run`, { agent: agentPref });
      toast(`Queued with ${agentPref === 'auto' ? 'automatic routing' : agentPref === 'claude' ? 'Claude' : 'Codex'}`, { kind: 'success' });
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Sheet
      title={t.title}
      onClose={onClose}
      footer={
        <>
          <button
            className="btn ghost danger"
            onClick={async () => {
              if (!confirm(`Delete “${t.title}”? Its runs and transcript are removed too.`)) return;
              try {
                await del(`/api/tasks/${t.id}`);
                onClose();
                toast('Task deleted');
              } catch (err) {
                toastError(err);
              }
            }}
          >
            <Trash2 size={14} strokeWidth={1.5} /> Delete
          </button>
          <span style={{ flex: 1 }} />
          <Link to={`/tasks/${t.id}`} className="btn">
            <ExternalLink size={14} strokeWidth={1.5} /> Open run view
          </Link>
        </>
      }
    >
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <StatusLabel status={t.status} />
        </dd>
        <dt>Agent</dt>
        <dd>
          <AgentBadge agent={t.agent} reason={t.route_reason} /> {t.route_reason ? <span className="faint" style={{ fontSize: 12 }}>· {t.route_reason}</span> : null}
        </dd>
        <dt>Type</dt>
        <dd>
          {TYPE_LABEL[t.type]} · {t.effort} effort{t.outward ? ' · outward' : ''}
        </dd>
        <dt>Project</dt>
        <dd>{project?.name ?? '—'}</dd>
        <dt>Created</dt>
        <dd className="mono" style={{ fontSize: 12 }}>
          {dateTime(t.created_at)}
        </dd>
        {t.due_at ? (
          <>
            <dt>Due</dt>
            <dd>{relTime(t.due_at)}</dd>
          </>
        ) : null}
        {t.not_before ? (
          <>
            <dt>Retries</dt>
            <dd>{relTime(t.not_before)}</dd>
          </>
        ) : null}
      </dl>
      {t.body ? <p style={{ marginTop: 16, whiteSpace: 'pre-wrap', fontSize: 13 }}>{t.body}</p> : null}
      {t.result_summary ? (
        <div style={{ marginTop: 16 }}>
          <div className="field-label" style={{ marginBottom: 6 }}>
            Result
          </div>
          <p style={{ fontSize: 13 }}>{t.result_summary}</p>
        </div>
      ) : null}
      {canRun ? (
        <div style={{ marginTop: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={() => void run('auto')}>
            <Play size={14} strokeWidth={1.5} /> Run
          </button>
          <button className="btn" onClick={() => void run('claude')}>
            Run with Claude
          </button>
          <button className="btn" onClick={() => void run('codex')}>
            Run with Codex
          </button>
        </div>
      ) : null}
    </Sheet>
  );
}
