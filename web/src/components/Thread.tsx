import { BookMarked, Check, ChevronDown, Copy, FileText, Globe, Image as ImageIcon, Repeat2, Scale, Search, Terminal, TriangleAlert, Wrench, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConversationRun, LiveRun } from '../lib/ask.ts';
import { agentName, askedText, otherAgent, runVisibility, sideLabel } from '../lib/ask.ts';
import { post } from '../lib/api.ts';
import { duration } from '../lib/format.ts';
import { plainText } from '../lib/markdown.tsx';
import { Answer } from '../lib/answer.tsx';
import { toast, toastError } from '../lib/toast.ts';
import type { AgentId, Approval, ContextReport, RunEvent } from '../lib/types.ts';
import { ApprovalCard } from './ApprovalCard.tsx';
import { Spinner } from './ui.tsx';

interface Step {
  id: string;
  line: string;
  tool: string;
  state: 'running' | 'done' | 'error';
}

function stepIcon(tool: string) {
  if (/search_memory|read_note|save_memory|search_conversations/.test(tool)) return BookMarked;
  if (/web_search|WebSearch|WebFetch/.test(tool)) return Globe;
  if (/Grep|Glob/.test(tool)) return Search;
  if (/Bash|shell/.test(tool)) return Terminal;
  if (/Read|Write|Edit/.test(tool)) return FileText;
  return Wrench;
}

/** Turn one run's stored events into what Ask shows: thinking, real steps, narration, the answer. */
export function digest(run: ConversationRun, live?: LiveRun) {
  const steps: Step[] = [];
  const byId = new Map<string, Step>();
  const narration: Array<{ at: number; text: string }> = [];
  const thinking: string[] = [];
  const files: Array<{ path: string; additions?: number; deletions?: number }> = [];
  const notes: string[] = [];
  let error: string | null = null;
  const assistant: RunEvent[] = [];
  for (const ev of run.events) {
    const p = ev.payload;
    if (ev.kind === 'tool_call') {
      const s: Step = { id: String(p.id ?? ev.id), line: String(p.activity ?? p.summary ?? p.tool), tool: String(p.tool ?? ''), state: 'running' };
      steps.push(s);
      byId.set(s.id, s);
      if (/read_note$/.test(s.tool) && typeof p.input?.path === 'string') notes.push(p.input.path);
    } else if (ev.kind === 'tool_result') {
      const s = byId.get(String(p.id));
      if (s) s.state = p.isError ? 'error' : 'done';
    } else if (ev.kind === 'message' && p.role === 'reasoning') {
      thinking.push(String(p.text ?? ''));
    } else if (ev.kind === 'message' && p.role === 'assistant') {
      assistant.push(ev);
    } else if (ev.kind === 'file_change') {
      files.push({ path: String(p.path ?? ''), additions: p.additions, deletions: p.deletions });
    } else if (ev.kind === 'error') {
      error = String(p.message ?? 'Something went wrong');
      const step = byId.get(String(p.id ?? p.toolCallId));
      if (step) step.state = 'error';
    }
  }
  const done = run.status !== 'running';
  // Text written between tool calls is narration ("Let me check your notes"); the last is the answer.
  const finalMsg = done ? assistant.at(-1) : undefined;
  for (const m of assistant) if (m !== finalMsg) narration.push({ at: m.id, text: String(m.payload.text ?? '') });
  const answer = done ? run.answer ?? (finalMsg ? String(finalMsg.payload.text ?? '') : '') : live?.text || run.answer || '';
  if (live?.thinking) thinking.push(live.thinking);
  return { steps, narration, thinking: thinking.join('\n\n').trim(), files, notes, error, answer, done };
}

function contextLabels(run: ConversationRun): string[] {
  try {
    const r = (run.context_report ?? (run.context_report_json ? JSON.parse(run.context_report_json) : null)) as ContextReport | null;
    return (r?.items ?? []).filter((i) => i.kind !== 'instructions').map((i) => i.label);
  } catch {
    return [];
  }
}

function Attachments({ run }: { run: ConversationRun }) {
  let list: Array<{ name: string; mime: string }> = [];
  try {
    list = run.attachments_json ? JSON.parse(run.attachments_json) : [];
  } catch {
    list = [];
  }
  if (!list.length) return null;
  return (
    <ul className="turn-files">
      {list.map((a) => (
        <li key={a.name} className="file-chip">
          {a.mime.startsWith('image/') ? <ImageIcon size={14} strokeWidth={1.5} /> : <FileText size={14} strokeWidth={1.5} />}
          <span className="file-chip-name">{a.name}</span>
        </li>
      ))}
    </ul>
  );
}

export function Turn({ run, live, approvals, conversationId, last, now, onAskOther, onDecided, consults = [], liveRuns = {} }: {
  run: ConversationRun;
  live?: LiveRun;
  approvals: Approval[];
  conversationId: string;
  last: boolean;
  now: number;
  onAskOther: (agent: AgentId) => void;
  onDecided: () => void;
  consults?: ConversationRun[];
  liveRuns?: Record<string, LiveRun>;
}) {
  const d = digest(run, live);
  const side = sideLabel(run);
  const agent = (run.agent === 'codex' ? 'codex' : 'claude') as AgentId;
  const [open, setOpen] = useState<boolean | null>(null);
  useEffect(() => { if (d.done) setOpen(null); }, [d.done]);
  const showWork = open ?? !d.done;
  const working = !d.done;
  const current = [...d.steps].reverse().find((s) => s.state === 'running');
  const took = run.ended_at ? duration(run.started_at, run.ended_at) : duration(run.started_at, null, now);
  const labels = contextLabels(run);
  const mine = approvals.filter((a) => a.run_id === run.id || (last && !a.run_id));
  if (runVisibility(run) !== 'conversation') return null;

  const remember = async () => {
    try {
      await post('/api/memory/remember', { text: d.answer.slice(0, 4000), source: `${agentName(agent)} on Ask` });
      toast('Saved to Inbox.md in your notes');
    } catch (err) {
      toastError(err);
    }
  };
  const second = async () => {
    try {
      const r = await post<{ agent: AgentId }>(`/api/conversations/${conversationId}/second-opinion`, { runId: run.id });
      toast(`${agentName(r.agent)} is checking the answer`);
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <article className={`turn${side ? ' side' : ''}`}>
      {side ? null : (
        <div className="turn-user">
          <div className="turn-user-bubble">
            <div className="turn-user-text">{askedText(run)}</div>
            <Attachments run={run} />
          </div>
        </div>
      )}
      <div className={`turn-agent agent-${agent}`}>
        <header className="turn-head">
          <span className={`dot${working ? ' live' : ''}`} style={{ color: `var(--agent-${agent})` }} />
          <span className="turn-agent-name" tabIndex={0} title={[run.model, run.effort ? `${run.effort} effort` : '', run.route_reason].filter(Boolean).join(' · ')}>{side ? side.text : agentName(agent)}</span>
          <span className="turn-meta turn-time">{took}</span>
        </header>

        {d.thinking || d.steps.length || d.narration.length || consults.length ? (
          <section className={`work${showWork ? ' open' : ''}`}>
            <button className="work-toggle" aria-expanded={showWork} onClick={() => setOpen(!showWork)}>
              {working ? <Spinner size={12} /> : <Check size={14} strokeWidth={1.5} />}
              <span className="work-summary">
                {working
                  ? current?.line ?? (d.thinking ? 'Thinking' : 'Working')
                  : `Worked for ${took}${d.steps.length ? ` · ${d.steps.length} ${d.steps.length === 1 ? 'step' : 'steps'}` : ''}`}
              </span>
              <ChevronDown size={14} strokeWidth={1.5} className="work-chevron" />
            </button>
            {showWork ? (
              <div className="work-body">
                {d.thinking ? <p className="work-thinking">{d.thinking}</p> : null}
                {d.narration.map((n) => (
                  <p key={n.at} className="work-narration">{n.text}</p>
                ))}
                {consults.filter((r) => runVisibility(r) === 'activity').map((r) => {
                  const consult = digest(r, liveRuns[r.id]);
                  const sentence = plainText(consult.answer).match(/^.*?[.!?](?:\s|$)|^.+$/)?.[0]?.trim() ?? 'Waiting for the answer';
                  return <details className="work-consult" key={r.id}><summary>Asked {agentName(r.agent)} for a second opinion · {sentence}</summary><Answer source={consult.answer} streaming={!consult.done} /></details>;
                })}
                {d.steps.length ? (
                  <ol className="work-steps">
                    {d.steps.map((s) => {
                      const Icon = s.state === 'error' ? TriangleAlert : stepIcon(s.tool);
                      return (
                        <li key={s.id} className={`work-step ${s.state}`}>
                          {s.state === 'running' ? <Spinner size={12} /> : <Icon size={14} strokeWidth={1.5} />}
                          <span>{s.line}</span>
                        </li>
                      );
                    })}
                  </ol>
                ) : null}
              </div>
            ) : null}
          </section>
        ) : working ? (
          <div className="work-pending">
            <Spinner size={12} /> {agentName(agent)} is starting
          </div>
        ) : null}

        {d.answer ? (
          <div className={`turn-answer prose${working ? ' streaming' : ''}`}>
            <Answer source={d.answer} streaming={working} />
          </div>
        ) : null}
        {run.status === 'failed' ? (
          <div className="turn-error">
            <X size={14} strokeWidth={1.5} /> {d.error ?? run.error ?? 'The run failed'}
          </div>
        ) : null}
        {run.status === 'cancelled' ? <div className="turn-error muted">Stopped</div> : null}

        {d.files.length ? (
          <ul className="turn-files">
            {d.files.map((f, i) => (
              <li key={`${f.path}-${i}`} className="file-chip">
                <FileText size={14} strokeWidth={1.5} />
                <span className="file-chip-name mono">{f.path.split(/[\\/]/).slice(-2).join('/')}</span>
                {f.additions !== undefined ? <span className="file-chip-meta"><span className="add">+{f.additions}</span> <span className="del">−{f.deletions ?? 0}</span></span> : null}
              </li>
            ))}
          </ul>
        ) : null}

        {mine.map((a) => (
          <ApprovalCard key={a.id} a={a} compact onDecided={onDecided} />
        ))}

        {d.done && run.status === 'done' && d.answer ? (
          <footer className="turn-actions">
            <button className="btn ghost sm" onClick={() => void navigator.clipboard?.writeText(d.answer).then(() => toast('Copied'))} title="Copy the answer">
              <Copy size={14} strokeWidth={1.5} /> Copy
            </button>
            <button className="btn ghost sm" onClick={() => void remember()} title="Save this answer to Inbox.md in your notes">
              <BookMarked size={14} strokeWidth={1.5} /> Remember
            </button>
            {!side ? (
              <button className="btn ghost sm" onClick={() => void second()} title={`${agentName(otherAgent(agent))} checks this answer (read-only)`}>
                <Scale size={14} strokeWidth={1.5} /> Second opinion
              </button>
            ) : null}
            {last && !side ? (
              <button className="btn ghost sm" onClick={() => onAskOther(otherAgent(agent))} title={`Send your next message to ${agentName(otherAgent(agent))}; it gets this conversation`}>
                <Repeat2 size={14} strokeWidth={1.5} /> Ask {agentName(otherAgent(agent))}
              </button>
            ) : null}
            {labels.length || d.notes.length ? (
              <span className="turn-used" title="What this answer was given or read from your notes">
                Used {[...labels, ...d.notes.map((n) => n.split('/').pop()!.replace(/\.md$/, ''))].slice(0, 4).join(', ')}
              </span>
            ) : null}
          </footer>
        ) : null}
      </div>
    </article>
  );
}
