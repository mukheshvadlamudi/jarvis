import { FileText, FolderGit2, GitBranch, GitPullRequest, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorBox, Link, PageHead, Segmented, Sheet, SkeletonRows, StatusLabel, TextInput } from '../components/ui.tsx';
import { del, patch, post } from '../lib/api.ts';
import { tokens } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Project } from '../lib/types.ts';

interface Worktree {
  path: string;
  branch: string | null;
  taskId: string;
  task: { id: string; title: string; status: string; output_path: string | null } | null;
  diff: { files: number; insertions: number; deletions: number } | null;
  dirty: number;
  pr: string | null;
}
interface ProjectInfo extends Project {
  open_tasks: number;
  exists: boolean;
  isGit: boolean;
  remote: string | null;
  branch: string | null;
  claudeMd: { tokens: number } | null;
  agentsMd: { tokens: number } | null;
  worktrees: Worktree[];
  error?: string;
}

function DocChip({ name, info }: { name: string; info: { tokens: number } | null }) {
  if (!info) return <span className="chip" title={`No ${name} — agents get no repo-specific rules`}>no {name}</span>;
  return (
    <span className={`chip${info.tokens > 3000 ? ' warn' : ' ok'}`} title={`${name}: ${info.tokens} tokens${info.tokens > 3000 ? ' — large files cost context on every run' : ''}`}>
      <FileText size={12} strokeWidth={1.5} /> {name} {tokens(info.tokens)}
    </span>
  );
}

function WorktreeRow({ p, w, reload }: { p: ProjectInfo; w: Worktree; reload: () => void }) {
  const [busy, setBusy] = useState(false);
  const requestPr = async () => {
    setBusy(true);
    try {
      await post(`/api/projects/${p.id}/worktrees/${w.taskId}/pr`);
      toast('Waiting for your approval — see Approvals (or Telegram).', { kind: 'success' });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const cleanup = async (force = false) => {
    setBusy(true);
    try {
      await del(`/api/projects/${p.id}/worktrees/${w.taskId}${force ? '?force=1' : ''}`);
      toast('Worktree removed (the branch is kept).', { kind: 'success' });
      reload();
    } catch (err) {
      const msg = (err as Error).message;
      if (!force && /uncommitted/.test(msg) && confirm(`${msg}\n\nRemove anyway?`)) {
        setBusy(false);
        return cleanup(true);
      }
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="row" style={{ flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <GitBranch size={14} strokeWidth={1.5} color="var(--text-faint)" style={{ marginTop: 3 }} />
      <div className="row-stack" style={{ flex: '1 1 240px' }}>
        {w.task ? (
          <Link to={`/tasks/${w.task.id}`} className="title" style={{ whiteSpace: 'normal' }}>
            {w.task.title}
          </Link>
        ) : (
          <span className="title">{w.taskId}</span>
        )}
        <span className="sub mono" style={{ fontSize: 11 }}>{w.branch ?? 'detached'}</span>
        <span className="sub" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {w.task ? <StatusLabel status={w.task.status} /> : null}
          {w.diff && !w.diff.files ? <span className="faint">no commits yet</span> : null}
          {w.diff && w.diff.files ? (
            <span className="mono" style={{ fontSize: 12 }}>
              {w.diff.files} file{w.diff.files === 1 ? '' : 's'} <span className="plus">+{w.diff.insertions}</span> <span className="minus">−{w.diff.deletions}</span>
            </span>
          ) : null}
          {w.dirty ? <span className="chip warn">{w.dirty} uncommitted</span> : null}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        {w.pr ? (
          <a href={w.pr} target="_blank" rel="noreferrer" className="btn sm">
            <GitPullRequest size={14} strokeWidth={1.5} /> View PR
          </a>
        ) : (
          <button className="btn sm" disabled={busy || !w.diff?.files || w.task?.status === 'running'} title={!w.diff?.files ? 'No commits on this branch yet' : 'Push and open a PR (asks for approval first)'} onClick={() => void requestPr()}>
            <GitPullRequest size={14} strokeWidth={1.5} /> Open PR
          </button>
        )}
        <button className="btn sm ghost icon" aria-label="Clean up worktree" title="Remove the worktree folder (keeps the branch)" disabled={busy || w.task?.status === 'running'} onClick={() => void cleanup()}>
          <Trash2 size={14} strokeWidth={1.5} />
        </button>
      </div>
    </li>
  );
}

function ProjectPanel({ p, reload, onEdit }: { p: ProjectInfo; reload: () => void; onEdit: () => void }) {
  return (
    <section className="panel" style={{ marginBottom: 16 }}>
      <div className="panel-head" style={{ flexWrap: 'wrap', paddingTop: 8, paddingBottom: 8 }}>
        <FolderGit2 size={16} strokeWidth={1.5} color="var(--text-muted)" />
        <h2>{p.name}</h2>
        {p.open_tasks ? (
          <Link to={`/board?project=${p.id}`} className="count">
            {p.open_tasks} open
          </Link>
        ) : null}
        <div className="right">
          <button className="btn sm ghost" onClick={onEdit}>
            Edit
          </button>
        </div>
      </div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          {p.path ? <span className="mono faint" style={{ fontSize: 12, overflowWrap: 'anywhere' }}>{p.path}</span> : <span className="faint" style={{ fontSize: 12 }}>No local folder — add one so coding tasks run in git worktrees.</span>}
          {p.error ? <span className="chip danger">{p.error}</span> : null}
        </div>
        {p.exists ? (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <DocChip name="CLAUDE.md" info={p.claudeMd} />
            <DocChip name="AGENTS.md" info={p.agentsMd} />
            {p.isGit ? <span className="chip mono">{p.branch ?? 'detached'}</span> : <span className="chip warn">not a git repo</span>}
            {p.remote ? <span className="chip mono" title={p.remote}>{p.remote.replace(/^https?:\/\/|^git@|\.git$/g, '').replace(':', '/')}</span> : p.isGit ? <span className="chip">no remote</span> : null}
          </div>
        ) : null}
        {p.vault_note ? (
          <Link to={`/memory?note=${encodeURIComponent(p.vault_note)}`} className="faint" style={{ fontSize: 12 }}>
            {p.vault_note} →
          </Link>
        ) : null}
      </div>
      {p.isGit ? (
        p.worktrees.length ? (
          <ul className="list" style={{ borderTop: '1px solid var(--border)' }}>
            {p.worktrees.map((w) => (
              <WorktreeRow key={w.path} p={p} w={w} reload={reload} />
            ))}
          </ul>
        ) : (
          <div className="faint" style={{ fontSize: 12, padding: '0 16px 16px' }}>
            No Jarvis worktrees. Coding tasks for this project get their own worktree under .jarvis-worktrees/.
          </div>
        )
      ) : null}
    </section>
  );
}

function ProjectSheet({ initial, onClose, onSaved }: { initial: ProjectInfo | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<Project['kind']>(initial?.kind ?? 'code');
  const [path, setPath] = useState(initial?.path ?? '');
  const [repo, setRepo] = useState(initial?.repo ?? '');
  const [note, setNote] = useState(initial?.vault_note ?? '');
  const save = async () => {
    try {
      const body = { name, kind, path: path || null, repo: repo || null, vault_note: note || null };
      if (initial) await patch(`/api/projects/${initial.id}`, body);
      else await post('/api/projects', body);
      onSaved();
      onClose();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <Sheet
      title={initial ? `Edit ${initial.name}` : 'New project'}
      onClose={onClose}
      footer={
        <>
          {initial ? (
            <button
              className="btn ghost danger"
              onClick={async () => {
                if (!confirm(`Remove ${initial.name} from Jarvis? Files and tasks are kept.`)) return;
                try {
                  await del(`/api/projects/${initial.id}`);
                  onSaved();
                  onClose();
                } catch (err) {
                  toastError(err);
                }
              }}
            >
              Remove
            </button>
          ) : null}
          <span style={{ flex: 1 }} />
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!name.trim()} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <div className="form-grid">
        <div className="field full">
          <label htmlFor="pj-name">Name</label>
          <TextInput id="pj-name" value={name} onValue={setName} placeholder="ClientEasy" />
          <span className="hint">Mention it in a task (“…in ClientEasy”) and Jarvis links the task and loads its project note.</span>
        </div>
        <div className="field full">
          <span className="field-label">Kind</span>
          <Segmented label="Kind" value={kind} onChange={setKind} options={[{ value: 'code', label: 'Code' }, { value: 'client', label: 'Client' }, { value: 'area', label: 'Area' }]} />
        </div>
        <div className="field full">
          <label htmlFor="pj-path">Local folder</label>
          <input id="pj-path" className="input mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\you\code\clienteasy" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="pj-repo">Repository</label>
          <input id="pj-repo" className="input mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="github.com/you/clienteasy" spellCheck={false} />
        </div>
        <div className="field">
          <label htmlFor="pj-note">Vault note</label>
          <input id="pj-note" className="input mono" value={note} onChange={(e) => setNote(e.target.value)} placeholder={`Projects/${name || 'Name'}.md`} spellCheck={false} />
        </div>
      </div>
    </Sheet>
  );
}

export default function Projects() {
  const res = useApi<{ projects: ProjectInfo[] }>('/api/projects/overview', ['project.*', 'run.finished', 'approval.updated']);
  const [editing, setEditing] = useState<ProjectInfo | 'new' | null>(null);
  const list = res.data?.projects ?? [];
  const code = list.filter((p) => p.kind === 'code');
  const other = list.filter((p) => p.kind !== 'code');
  return (
    <div className="page">
      <PageHead title="Projects" sub={res.data ? `${code.length} code · ${other.length} client & areas` : undefined}>
        <button className="btn primary" onClick={() => setEditing('new')}>
          <Plus size={14} strokeWidth={1.5} /> New project
        </button>
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
      {res.loading ? (
        <div className="panel">
          <SkeletonRows rows={4} />
        </div>
      ) : null}
      {!res.loading && !list.length ? (
        <div className="panel">
          <Empty title="No projects yet" action={<button className="btn" onClick={() => setEditing('new')}><Plus size={14} strokeWidth={1.5} /> New project</button>}>
            Register local repos so coding tasks run in isolated git worktrees, and clients or areas so tasks pick up the right vault note.
          </Empty>
        </div>
      ) : null}
      {code.map((p) => (
        <ProjectPanel key={p.id} p={p} reload={res.reload} onEdit={() => setEditing(p)} />
      ))}
      {other.length ? (
        <section className="panel" style={{ marginTop: 24 }}>
          <div className="panel-head">
            <h2>Clients and areas</h2>
          </div>
          <ul className="list">
            {other.map((p) => (
              <li key={p.id}>
                <button className="row" onClick={() => setEditing(p)}>
                  <span className="chip">{p.kind}</span>
                  <div className="row-stack">
                    <span className="title">{p.name}</span>
                    <span className="sub mono" style={{ fontSize: 11 }}>{p.vault_note ?? 'no vault note'}</span>
                  </div>
                  {p.open_tasks ? <span className="time">{p.open_tasks} open</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {editing ? <ProjectSheet initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={res.reload} /> : null}
    </div>
  );
}
