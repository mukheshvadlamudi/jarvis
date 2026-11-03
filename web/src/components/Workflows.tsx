import { useState } from 'react';
import { Check, Circle, GitBranch, Play, X } from 'lucide-react';
import { post } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import type { RunDetail, Workflow, WorkflowList } from '../lib/workflows.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { ErrorBox, Link, Spinner } from './ui.tsx';
import type { Approval } from '../lib/types.ts';

export function WorkflowLauncher({ workflow, conversationId, onStarted }: { workflow: Workflow; conversationId?: string; onStarted?: () => void }) {
  const [open, setOpen] = useState(false); const [input, setInput] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState<Error | null>(null);
  return <div className="workflow-launcher"><button className="btn sm" onClick={() => setOpen(v => !v)} aria-expanded={open}><Play size={14} /> Run</button>{open && <form className="workflow-launch-input" onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await post<{ conversationId: string }>(`/api/workflows/${workflow.id}/run`, { input, conversationId }); onStarted?.(); navigate(`/c/${r.conversationId}`); }
    catch (e) { setError(e as Error); } finally { setBusy(false); }
  }}><label>{workflow.input.label}<input autoFocus className="input" value={input} onChange={e => setInput(e.target.value)} required={workflow.input.required} maxLength={20000} /></label><button className="btn primary" disabled={busy}>{busy ? <Spinner /> : 'Start workflow'}</button>{error && <ErrorBox error={error} />}</form>}</div>;
}

export function WorkflowMenu({ conversationId, onStarted }: { conversationId?: string; onStarted: () => void }) {
  const list = useApi<WorkflowList>('/api/workflows', ['workflow.updated']);
  return <div className="workflow-menu">{list.error && <ErrorBox error={list.error} onRetry={list.reload} />}{list.loading && <Spinner />}{list.data?.workflows.map(w => <div className="workflow-menu-row" key={w.id}><div><strong>{w.name}</strong><p>{w.description}</p></div><WorkflowLauncher workflow={w} conversationId={conversationId} onStarted={onStarted} /></div>)}<Link to="/workflows" onClick={onStarted} className="workflow-manage">Manage workflows <span aria-hidden="true">→</span></Link></div>;
}

export function WorkflowProgress({ run, approvals = [], onChanged }: { run: RunDetail; approvals?: Approval[]; onChanged?: () => void }) {
  const [error, setError] = useState<Error | null>(null); const [busy, setBusy] = useState(false);
  const waiting = Object.values(run.results).find(r => r.state === 'waiting_approval');
  const approval = approvals.find(a => a.id === waiting?.approvalId);
  const active = ['running','waiting_approval'].includes(run.status);
  const cancel = async () => { setBusy(true); try { await post(`/api/workflow-runs/${run.id}/cancel`); onChanged?.(); } catch(e) { setError(e as Error); } finally { setBusy(false); } };
  const labels: Record<string, string> = { running: 'Running', done: 'Done', failed: 'Failed', waiting_approval: 'Waiting for you', skipped: 'Skipped', queued: 'Queued', cancelled: 'Cancelled' };
  return <section className="workflow-progress" aria-label="Workflow progress" aria-live="polite"><header><div><span className="workflow-eyebrow"><GitBranch size={14} /> Workflow progress</span><h2>{run.definition.name}</h2></div><span className={`workflow-state ${run.status}`}>{labels[run.status]}</span></header>{approval && <ApprovalCard a={approval} compact inline onDecided={onChanged} onCancel={() => void cancel()} cancelling={busy} />}<ol>{run.definition.steps.map((s, index) => {
    const result = run.results[s.id]; const state = result?.state ?? 'queued';
    return <li key={s.id} className={`workflow-step ${state}`}><span className="workflow-step-icon">{state === 'running' ? <Spinner /> : state === 'done' ? <Check size={14} /> : state === 'failed' ? <X size={14} /> : <Circle size={12} />}</span><span className="workflow-step-name">{index + 1}. {s.id.replaceAll('-', ' ')}</span><span className="workflow-step-agent">{result?.agent ?? ('agent' in s ? s.agent : s.kind === 'approval' ? 'You' : 'Jarvis')}</span><span className="workflow-step-state">{labels[state]}</span></li>;
  })}</ol>{run.error && <p className="workflow-error">{run.error}</p>}{active && !approval && <footer><button className="btn ghost sm" disabled={busy} onClick={() => void cancel()}>Cancel workflow</button></footer>}{error && <ErrorBox error={error} />}</section>;
}
