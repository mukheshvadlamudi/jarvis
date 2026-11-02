import { AlertCircle, ArrowLeft, CircleStop, FileDiff, Globe, ListChecks, RotateCcw, Send, Terminal, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { AgentBadge, Disclosure, Empty, ErrorBox, Link, MicButton, Skeleton, StatusLabel } from '../components/ui.tsx';
import { api, post } from '../lib/api.ts';
import { clock, dateTime, duration, TYPE_LABEL, tokens } from '../lib/format.ts';
import { useApi, useNow } from '../lib/hooks.ts';
import { useLive } from '../lib/live.ts';
import { navigate, setQuery, useLocation } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Approval, ContextReport, Project, Run, RunEvent, Task } from '../lib/types.ts';
import type { PageProps } from '../routes.ts';

interface TaskDetail {
  task: Task;
  runs: Run[];
  approvals: Approval[];
  project: Project | null;
  active: boolean;
}
interface RunDetail {
  run: Run;
  task: Task;
  approvals: Approval[];
  live: boolean;
}

type Item =
  | { kind: 'message'; ev: RunEvent }
  | { kind: 'tool'; call: RunEvent; result?: RunEvent }
  | { kind: 'file'; evs: RunEvent[] }
  | { kind: 'status'; ev: RunEvent }
  | { kind: 'error'; ev: RunEvent };

function buildItems(events: RunEvent[]): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, number>();
  for (const ev of events) {
    if (ev.kind === 'tool_call') {
      toolIndex.set(String(ev.payload.id), items.length);
      items.push({ kind: 'tool', call: ev });
    } else if (ev.kind === 'tool_result') {
      const i = toolIndex.get(String(ev.payload.id));
      if (i !== undefined && items[i].kind === 'tool') (items[i] as { result?: RunEvent }).result = ev;
      else items.push({ kind: 'tool', call: { ...ev, kind: 'tool_call', payload: { tool: ev.payload.tool ?? 'tool', input: {} } }, result: ev });
    } else if (ev.kind === 'file_change') {
      const last = items.at(-1);
      if (last?.kind === 'file') last.evs.push(ev);
      else items.push({ kind: 'file', evs: [ev] });
    } else if (ev.kind === 'message') items.push({ kind: 'message', ev });
    else if (ev.kind === 'error') items.push({ kind: 'error', ev });
    else if (ev.kind === 'status') items.push({ kind: 'status', ev });
  }
  return items;
}

function toolIcon(tool: string) {
  if (/bash|shell|powershell/i.test(tool)) return Terminal;
  if (/web_search|webfetch/i.test(tool)) return Globe;
  if (/edit|write/i.test(tool)) return FileDiff;
  return Wrench;
}

function toolTarget(p: Record<string, any>): string {
  if (p.summary) return String(p.summary);
  const i = p.input ?? {};
  return String(i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.query ?? i.url ?? (Object.keys(i).length ? JSON.stringify(i) : ''));
}

function ToolRow({ call, result }: { call: RunEvent; result?: RunEvent }) {
  const tool = String(call.payload.tool ?? 'tool');
  const Icon = toolIcon(tool);
  const err = result?.payload.isError === true;
  const dur = result ? duration(call.ts, result.ts) : null;
  const input = call.payload.input ?? {};
  return (
    <div className={err ? 'tool err' : 'tool'}>
      <Disclosure
        summary={
          <>
            <Icon size={14} strokeWidth={1.5} style={{ flex: 'none' }} />
            <span className="name">{tool.replace(/^mcp__/, '').replace(/__/g, '.')}</span>
            <span className="target">{toolTarget(call.payload)}</span>
            {call.payload.risk === 'ask' ? <span className="chip warn" style={{ height: 18 }}>approval</span> : null}
            <span className="dur">{result ? dur : <span className="dot live" style={{ display: 'inline-block' }} />}</span>
          </>
        }
      >
        <div>
          <div className="code-label">Input</div>
          <pre className="code">{typeof input.command === 'string' ? input.command : JSON.stringify(input, null, 2)}</pre>
        </div>
        {result ? (
          <div>
            <div className="code-label">
              Output{result.payload.exitCode !== undefined && result.payload.exitCode !== null ? ` · exit ${result.payload.exitCode}` : ''}
              {result.payload.truncated ? ' · truncated by Jarvis' : ''}
            </div>
            <pre className="code" style={err ? { borderColor: 'var(--danger)' } : undefined}>
              {String(result.payload.output ?? '') || '(no output)'}
            </pre>
          </div>
        ) : (
          <div className="faint" style={{ fontSize: 12 }}>
            Running…
          </div>
        )}
      </Disclosure>
    </div>
  );
}

const CTX_COLORS: Record<string, string> = {
  core: 'var(--accent)',
  project: 'var(--info)',
  skills: 'var(--agent-codex)',
  instructions: 'var(--text-faint)',
  other: 'var(--agent-claude)',
};

export function ContextInspector({ report }: { report: ContextReport | null | undefined }) {
  if (!report) return <p className="faint" style={{ fontSize: 12 }}>No context report for this run (follow-ups reuse the session’s context).</p>;
  const pct = Math.min(100, (report.totalTokens / report.budgetTokens) * 100);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span className="muted">Loaded into the prompt</span>
        <span className="mono num">
          {tokens(report.totalTokens)} / {tokens(report.budgetTokens)}
        </span>
      </div>
      <div className="ctx-bar" role="img" aria-label={`${Math.round(pct)}% of the context budget used`}>
        {report.items.map((it, i) => (
          <span key={i} style={{ width: `${(it.tokens / report.budgetTokens) * 100}%`, background: CTX_COLORS[it.kind] ?? CTX_COLORS.other }} />
        ))}
      </div>
      <table className="ctx-table">
        <tbody>
          {report.items.map((it, i) => (
            <tr key={i}>
              <td>
                <span className="swatch" style={{ background: CTX_COLORS[it.kind] ?? CTX_COLORS.other }} />
                {it.path ? (
                  <Link to={`/memory?note=${encodeURIComponent(it.path)}`}>{it.label}</Link>
                ) : (
                  it.label
                )}
                {it.truncated ? <span className="chip warn" style={{ marginLeft: 6, height: 18 }}>trimmed</span> : null}
              </td>
              <td>{tokens(it.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.truncated ? <p style={{ fontSize: 12, color: 'var(--warning)' }}>Over budget: lower-priority parts were trimmed. Agents can still fetch notes on demand.</p> : null}
    </div>
  );
}

export default function RunPage({ params }: PageProps) {
  const isTask = params.id.startsWith('t_');
  const { query } = useLocation();
  const taskRes = useApi<TaskDetail>(isTask ? `/api/tasks/${params.id}` : null, ['task.updated', 'run.started', 'run.finished', 'approval.*']);
  const runRes = useApi<RunDetail>(!isTask ? `/api/runs/${params.id}` : null, ['run.finished', 'approval.*', 'task.updated']);
  const task = isTask ? taskRes.data?.task : runRes.data?.task;
  const runs = taskRes.data?.runs ?? [];
  const runId = isTask ? query.get('run') ?? runs[0]?.id ?? null : params.id;
  const runDetail = useApi<RunDetail>(isTask && runId ? `/api/runs/${runId}` : null, ['run.finished', 'approval.*']);
  const detail = isTask ? runDetail.data : runRes.data;
  const run = detail?.run ?? null;
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const now = useNow(1000);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      return;
    }
    let cancelled = false;
    setLoadingEvents(true);
    api<{ events: RunEvent[] }>(`/api/runs/${runId}/events?limit=2000`)
      .then((r) => !cancelled && setEvents(r.events))
      .catch(() => undefined)
      .finally(() => !cancelled && setLoadingEvents(false));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  useLive(['run.event'], (e) => {
    if (e.data?.run_id !== runId || typeof e.data?.id !== 'number') return;
    setEvents((cur) => (cur.some((x) => x.id === e.data.id) ? cur : [...cur, { id: e.data.id, run_id: e.data.run_id, ts: e.data.ts, kind: e.data.kind, payload: e.data.payload }]));
  });

  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (stick.current && run?.status === 'running') bottom.current?.scrollIntoView({ block: 'end' });
  }, [events.length, run?.status]);

  const items = useMemo(() => buildItems(events), [events]);
  const live = run?.status === 'running';
  const approvals = (detail?.approvals ?? []).filter((a) => a.status === 'pending');
  const error = isTask ? taskRes.error : runRes.error;
  const files = events.filter((e) => e.kind === 'file_change');

  const stop = async () => {
    if (!task) return;
    try {
      await post(`/api/tasks/${task.id}/cancel`);
      toast('Stopping the run…');
    } catch (err) {
      toastError(err);
    }
  };
  const send = async () => {
    if (!task || !text.trim() || sending) return;
    setSending(true);
    try {
      const r = await post<{ mode: string; runId?: string }>(`/api/tasks/${task.id}/followup`, { text: text.trim() });
      setText('');
      if (r.mode === 'resumed' && r.runId) {
        if (isTask) setQuery({ run: r.runId });
        else navigate(`/runs/${r.runId}`);
        toast('Resumed the session with your follow-up.', { kind: 'success' });
      } else if (r.mode === 'queued') toast('Both slots are busy — your follow-up is queued.', { kind: 'info' });
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };
  const rerun = async () => {
    if (!task) return;
    try {
      await post(`/api/tasks/${task.id}/run`);
      toast('Queued a fresh run.', { kind: 'success' });
    } catch (err) {
      toastError(err);
    }
  };

  if (error) {
    return (
      <div className="page">
        <ErrorBox error={error} />
        <div style={{ marginTop: 16 }}>
          <Link to="/board" className="btn">
            Back to the board
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ marginBottom: 12 }}>
        <button className="btn ghost sm" onClick={() => (history.length > 1 ? history.back() : navigate('/board'))}>
          <ArrowLeft size={14} strokeWidth={1.5} /> Back
        </button>
      </div>
      <header className="page-head" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0, flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {task ? <h1 style={{ overflowWrap: 'anywhere' }}>{task.title}</h1> : <Skeleton w={320} h={20} />}
          {task ? (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
              <StatusLabel status={task.status} />
              <AgentBadge agent={run?.agent ?? task.agent} reason={run?.route_reason ?? task.route_reason} />
              <span className="faint">{TYPE_LABEL[task.type]}</span>
              {run?.route_reason ? <span className="faint">routing: {run.route_reason}</span> : null}
              {taskRes.data?.project ? <span className="faint">{taskRes.data.project.name}</span> : null}
            </div>
          ) : null}
        </div>
        <div className="actions">
          {live ? (
            <button className="btn" onClick={() => void stop()}>
              <CircleStop size={14} strokeWidth={1.5} /> Stop
            </button>
          ) : task && !['running', 'queued'].includes(task.status) ? (
            <button className="btn" onClick={() => void rerun()}>
              <RotateCcw size={14} strokeWidth={1.5} /> Run again
            </button>
          ) : null}
        </div>
      </header>

      {task?.body ? (
        <p className="muted" style={{ marginBottom: 20, whiteSpace: 'pre-wrap', fontSize: 13 }}>
          {task.body}
        </p>
      ) : null}

      <div className="run-layout">
        <div style={{ minWidth: 0 }}>
          {approvals.length ? (
            <div className="panel" style={{ marginBottom: 16, borderColor: 'var(--warning)' }}>
              {approvals.map((a) => (
                <ApprovalCard key={a.id} a={{ ...a, task_title: task?.title }} onDecided={() => (isTask ? runDetail.reload() : runRes.reload())} />
              ))}
            </div>
          ) : null}

          {task?.result_summary && !live ? (
            <div className={task.status === 'failed' ? 'error-box' : 'notice'} style={{ marginBottom: 16, borderLeftColor: task.status === 'done' ? 'var(--success)' : undefined }}>
              <ListChecks size={16} strokeWidth={1.5} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, marginBottom: 2 }}>Result</div>
                <div style={{ overflowWrap: 'anywhere' }}>{task.result_summary}</div>
              </div>
            </div>
          ) : null}

          {task?.not_before && task.status === 'queued' ? (
            <div className="notice" style={{ marginBottom: 16 }}>
              <AlertCircle size={16} strokeWidth={1.5} />
              <div>
                {task.route_reason}. Jarvis retries automatically {new Date(task.not_before).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}.
              </div>
            </div>
          ) : null}

          <section aria-label="Transcript" className="transcript">
            {loadingEvents && !events.length ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <Skeleton w="70%" />
                <Skeleton w="45%" h={28} />
                <Skeleton w="80%" />
              </div>
            ) : null}
            {!loadingEvents && !events.length && !runId && task ? (
              <Empty title={task.status === 'queued' ? 'Waiting for a free slot.' : 'This task has not run yet.'}>
                {task.status === 'inbox' ? 'Run it from here or drag it to Queued on the board.' : 'The transcript appears here live once an agent starts.'}
              </Empty>
            ) : null}
            {run?.prompt && events.length ? (
              <div className="msg user">
                <span className="msg-label">You</span>
                {run.prompt}
              </div>
            ) : null}
            {items.map((it, i) => {
              if (it.kind === 'tool') return <ToolRow key={i} call={it.call} result={it.result} />;
              if (it.kind === 'file')
                return (
                  <div key={i} style={{ padding: '2px 0' }}>
                    {it.evs.map((e) => (
                      <div className="file-change" key={e.id}>
                        <FileDiff size={14} strokeWidth={1.5} />
                        <span className="path">{String(e.payload.path)}</span>
                        <span className="faint">{String(e.payload.kind ?? '')}</span>
                        {e.payload.additions !== undefined ? <span className="plus">+{e.payload.additions}</span> : null}
                        {e.payload.deletions !== undefined ? <span className="minus">−{e.payload.deletions}</span> : null}
                      </div>
                    ))}
                  </div>
                );
              if (it.kind === 'error')
                return (
                  <div key={i} className="status-line err">
                    <AlertCircle size={14} strokeWidth={1.5} /> {String(it.ev.payload.message)}
                  </div>
                );
              if (it.kind === 'status') {
                if (it.ev.payload.status === 'plan' && Array.isArray(it.ev.payload.items)) {
                  return (
                    <div key={i} className="status-line">
                      <ListChecks size={14} strokeWidth={1.5} /> Plan: {(it.ev.payload.items as Array<{ text: string; completed: boolean }>).map((x) => `${x.completed ? '✓' : '○'} ${x.text}`).join('  ')}
                    </div>
                  );
                }
                return (
                  <div key={i} className="status-line">
                    <span className="mono">{clock(it.ev.ts)}</span> {String(it.ev.payload.detail ?? it.ev.payload.summary ?? it.ev.payload.status)}
                  </div>
                );
              }
              const role = it.ev.payload.role;
              return (
                <div key={i} className={`msg ${role === 'user' ? 'user' : role === 'reasoning' ? 'reasoning' : ''}`}>
                  {role === 'user' ? <span className="msg-label">You</span> : null}
                  {String(it.ev.payload.text ?? '')}
                </div>
              );
            })}
            {live ? (
              <div className="status-line" aria-live="polite">
                <span className="dot live" /> Working · {run ? duration(run.started_at, null, now) : ''}
              </div>
            ) : null}
            <div ref={bottom} />
          </section>

          {task ? (
            <div className="run-footer">
              <div className="run-footer-inner">
                <label htmlFor="followup" className="sr-only">
                  Follow-up
                </label>
                <textarea
                  id="followup"
                  rows={1}
                  value={text}
                  placeholder={live ? 'Steer the agent while it works…' : run?.session_id ? 'Follow up — resumes the same session' : 'Add instructions and run'}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      void send();
                    }
                  }}
                />
                <MicButton onText={(t) => setText((c) => (c ? `${c} ${t}` : t))} />
                {live ? (
                  <button className="btn sm" onClick={() => void stop()} aria-label="Stop">
                    <CircleStop size={14} strokeWidth={1.5} />
                  </button>
                ) : null}
                <button className="btn primary sm icon" disabled={!text.trim() || sending} onClick={() => void send()} aria-label="Send follow-up">
                  <Send size={14} strokeWidth={1.5} />
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <div className="panel">
            <div className="panel-head">
              <h2>Run</h2>
              {run ? <span className="count mono">{run.id}</span> : null}
            </div>
            <div className="panel-body">
              {run ? (
                <dl className="kv">
                  <dt>Started</dt>
                  <dd className="mono" style={{ fontSize: 12 }}>{dateTime(run.started_at)}</dd>
                  <dt>Duration</dt>
                  <dd className="mono num" style={{ fontSize: 12 }}>{duration(run.started_at, run.ended_at, now)}</dd>
                  <dt>Tokens</dt>
                  <dd className="mono num" style={{ fontSize: 12 }}>
                    {tokens(run.input_tokens)} in · {tokens(run.output_tokens)} out
                  </dd>
                  <dt>Cached</dt>
                  <dd className="mono num" style={{ fontSize: 12 }}>{tokens(run.cached_tokens)}</dd>
                  <dt>Tool calls</dt>
                  <dd className="mono num" style={{ fontSize: 12 }}>{run.tool_calls}</dd>
                  <dt>Files</dt>
                  <dd className="mono num" style={{ fontSize: 12 }}>{files.length}</dd>
                  <dt>Folder</dt>
                  <dd className="mono" style={{ fontSize: 12 }}>{run.cwd}</dd>
                  {run.session_id ? (
                    <>
                      <dt>Session</dt>
                      <dd className="mono" style={{ fontSize: 12 }}>{run.session_id}</dd>
                    </>
                  ) : null}
                </dl>
              ) : (
                <p className="faint" style={{ fontSize: 12 }}>No run yet.</p>
              )}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>Context</h2>
            </div>
            <div className="panel-body">
              <ContextInspector report={run?.context_report ?? null} />
            </div>
          </div>

          {isTask && runs.length > 1 ? (
            <div className="panel">
              <div className="panel-head">
                <h2>Runs</h2>
                <span className="count">{runs.length}</span>
              </div>
              <ul className="list">
                {runs.map((r) => (
                  <li key={r.id}>
                    <button className={`row${r.id === runId ? ' selected' : ''}`} onClick={() => setQuery({ run: r.id })}>
                      <StatusLabel status={r.status} />
                      <span className="title mono" style={{ fontSize: 12, fontWeight: 400 }}>
                        {r.prompt?.split('\n')[0] ?? r.id}
                      </span>
                      <span className="time">{clock(r.started_at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
