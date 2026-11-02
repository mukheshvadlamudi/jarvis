import { useState } from 'react';
import { post } from '../lib/api.ts';
import { relTime } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Approval } from '../lib/types.ts';
import { AgentBadge, Link, TextInput } from './ui.tsx';

const KIND_LABEL: Record<string, string> = {
  git_push: 'Push to remote',
  pull_request: 'Pull request',
  publish: 'Publish',
  http_write: 'Web request',
  send_email: 'Send email',
  outward_mcp: 'Outward action',
  write_outside: 'Write outside task folder',
  delete_outside: 'Delete outside task folder',
  memory_edit: 'Memory edit',
  request: 'Agent request',
};

export function commandOf(a: Approval): string {
  const input = a.detail?.input as Record<string, unknown> | undefined;
  if (!input) return '';
  if (typeof input.command === 'string') return input.command;
  return JSON.stringify(input, null, 2);
}

export function ApprovalCard({ a, onDecided, compact }: { a: Approval; onDecided?: () => void; compact?: boolean }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<null | 'approved' | 'rejected'>(null);
  const what = a.summary.replace(/^[A-Za-z_]+: /, '');
  const cmd = commandOf(a);
  const decide = async (decision: 'approved' | 'rejected') => {
    setBusy(decision);
    try {
      await post(`/api/approvals/${a.id}`, { decision, note: note.trim() || undefined });
      toast(decision === 'approved' ? 'Approved — the agent will continue.' : 'Rejected — the agent will skip that action.', { kind: decision === 'approved' ? 'success' : 'info' });
      onDecided?.();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(null);
    }
  };
  const pending = a.status === 'pending';
  return (
    <article className="approval" aria-label={`Approval: ${a.summary}`}>
      <div className="approval-meta">
        <span className={`chip ${pending ? 'warn' : a.status === 'approved' ? 'ok' : a.status === 'rejected' ? 'danger' : ''}`}>{KIND_LABEL[a.kind] ?? a.kind}</span>
        <AgentBadge agent={a.detail?.agent ?? a.task_agent ?? null} />
        <span className="mono">{relTime(a.created_at)}</span>
        {!pending ? (
          <span>
            {a.status} {a.decided_via ? `via ${a.decided_via}` : ''} {a.decided_at ? relTime(a.decided_at) : ''}
          </span>
        ) : a.live === false ? (
          <span title="The run that asked has ended. Approving resumes its session with this action.">resumes on approve</span>
        ) : null}
      </div>
      <div className="approval-what">{what}</div>
      {a.detail?.reason ? <div className="muted" style={{ fontSize: 13 }}>Why: {String(a.detail.reason)}</div> : null}
      {cmd && !compact ? <pre className="code">{cmd}</pre> : cmd ? <pre className="code" style={{ maxHeight: 96 }}>{cmd}</pre> : null}
      {a.task_id ? (
        <div style={{ fontSize: 12 }}>
          <Link to={a.run_id ? `/runs/${a.run_id}` : `/tasks/${a.task_id}`} className="faint">
            {a.task_title ?? 'Open task'} →
          </Link>
        </div>
      ) : null}
      {a.note && !pending ? <div className="muted" style={{ fontSize: 13 }}>Note: {a.note}</div> : null}
      {pending ? (
        <div className="approval-actions">
          <TextInput value={note} onValue={setNote} placeholder="Note for the agent (optional)" aria-label="Note for the agent" />
          <button className="btn ghost" disabled={!!busy} onClick={() => void decide('rejected')}>
            Reject
          </button>
          <button className="btn primary" disabled={!!busy} onClick={() => void decide('approved')}>
            Approve
          </button>
        </div>
      ) : null}
    </article>
  );
}
