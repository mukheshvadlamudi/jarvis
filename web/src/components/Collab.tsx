import { ArrowRightLeft, CornerDownRight, MessagesSquare, X } from 'lucide-react';
import { useState } from 'react';
import { api, post } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { AgentId, RunEvent, Task } from '../lib/types.ts';
import { Link, Segmented, StatusLabel } from './ui.tsx';
import { Markdown } from '../lib/markdown.tsx';

const NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const other = (a: string | null | undefined): AgentId => (a === 'codex' ? 'claude' : 'codex');

/** A consult in the transcript: the question and, once in, the other agent's answer. */
export function ConsultBlock({ asked, answered }: { asked: RunEvent; answered?: RunEvent }) {
  const p = asked.payload;
  const to = String(p.to ?? '');
  return (
    <div className={`consult agent-${to}`}>
      <div className="consult-head">
        <MessagesSquare size={14} strokeWidth={1.5} />
        <span>
          {NAME[String(p.from)] ?? 'Agent'} asked {NAME[to] ?? 'the other agent'}
        </span>
        {!answered ? <span className="dot live" style={{ display: 'inline-block', marginLeft: 'auto' }} /> : null}
      </div>
      <div className="consult-q">{String(p.question ?? '')}</div>
      {answered ? (
        <div className="consult-a">
          <CornerDownRight size={14} strokeWidth={1.5} style={{ flex: 'none', marginTop: 2 }} />
          <Markdown source={String(answered.payload.answer ?? '')} />
        </div>
      ) : null}
    </div>
  );
}

interface Links {
  parent: Task | null;
  children: Array<Pick<Task, 'id' | 'title' | 'status' | 'agent' | 'agent_pref'> & { handoff_json: string | null }>;
  consults: Array<{ id: string; agent: string; status: string }>;
  then: { agent: string; mode: 'review' | 'continue'; instructions?: string } | null;
  origin: { fromAgent: string; mode: 'review' | 'continue' } | null;
  consultsLeft: number;
}

/** Hand a task to the other agent (review or continue), now or when it finishes. */
export function CollabPanel({ task }: { task: Task }) {
  const res = useApi<Links>(`/api/tasks/${task.id}/links`, ['task.created', 'task.updated', 'run.finished']);
  const [mode, setMode] = useState<'review' | 'continue'>('review');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const from = task.agent ?? (task.agent_pref === 'auto' ? null : task.agent_pref);
  const to = other(from);
  const l = res.data;
  const finished = ['done', 'failed', 'cancelled'].includes(task.status);
  const canHand = task.status !== 'inbox';

  const hand = async () => {
    setBusy(true);
    try {
      const r = await post<{ mode: 'now' | 'after'; task: Task | null }>(`/api/tasks/${task.id}/handoff`, { agent: to, mode, instructions: note.trim() || undefined });
      setNote('');
      if (r.mode === 'now' && r.task) toast(`${NAME[to]} is on it: ${r.task.title}`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${r.task!.id}`) } });
      else toast(`${NAME[to]} will ${mode === 'review' ? 'review' : 'continue'} this when it finishes.`, { kind: 'success' });
      res.reload();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const cancelThen = async () => {
    try {
      await api(`/api/tasks/${task.id}/handoff`, { method: 'DELETE' });
      res.reload();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Agents</h2>
        {l ? (
          <span className="right faint" style={{ fontSize: 12 }} title="Times an agent may still ask the other for a second opinion">
            {l.consults.length} consult{l.consults.length === 1 ? '' : 's'} · {l.consultsLeft} left
          </span>
        ) : null}
      </div>
      <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {l?.parent ? (
          <div className="collab-link">
            <span className="faint">{l.origin ? `${l.origin.mode === 'review' ? 'Reviewing' : 'Continuing'} ${NAME[l.origin.fromAgent] ?? ''}'s work` : 'Follows'}</span>
            <Link to={`/tasks/${l.parent.id}`}>{l.parent.title}</Link>
          </div>
        ) : null}
        {l?.children.map((c) => (
          <div className="collab-link" key={c.id}>
            <span className="faint">
              <ArrowRightLeft size={12} strokeWidth={1.5} style={{ verticalAlign: -2 }} /> {NAME[c.agent ?? c.agent_pref] ?? 'Agent'}
            </span>
            <Link to={`/tasks/${c.id}`}>{c.title}</Link>
            <StatusLabel status={c.status} />
          </div>
        ))}
        {l?.then ? (
          <div className="collab-link">
            <span className="chip accent" style={{ height: 20 }}>
              Next: {NAME[l.then.agent] ?? NAME[to]} {l.then.mode === 'review' ? 'reviews' : 'continues'}
            </span>
            <button className="btn ghost icon sm" aria-label="Cancel the planned handoff" title="Cancel the planned handoff" onClick={() => void cancelThen()}>
              <X size={14} strokeWidth={1.5} />
            </button>
          </div>
        ) : null}
        {canHand ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <Segmented<'review' | 'continue'>
              label="Handoff mode"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'review', label: `${NAME[to]} reviews` },
                { value: 'continue', label: `${NAME[to]} continues` },
              ]}
            />
            <textarea className="input" rows={2} placeholder={mode === 'review' ? 'What to check (optional)' : 'What to do next (optional)'} value={note} onChange={(e) => setNote(e.target.value)} style={{ resize: 'vertical', minHeight: 56 }} />
            <button className="btn sm" disabled={busy || !!l?.then} onClick={() => void hand()}>
              <ArrowRightLeft size={14} strokeWidth={1.5} />
              {finished ? `Hand to ${NAME[to]}` : `Hand to ${NAME[to]} when done`}
            </button>
            <span className="faint" style={{ fontSize: 11 }}>
              {mode === 'review' ? `${NAME[to]} reads the same folder in a read-only sandbox and reports issues.` : `${NAME[to]} picks up in the same folder with this task's result as context.`}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
