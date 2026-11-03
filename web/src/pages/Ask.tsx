import { WorkflowMenu, WorkflowProgress } from '../components/Workflows.tsx';
import type { WorkflowList } from '../lib/workflows.ts';
import { GitBranch, History, MessageSquarePlus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentStrip } from '../components/AgentStrip.tsx';
import { VoiceMode, VoiceUsage } from '../components/voice-mode/VoiceMode.tsx';
import { rememberSetting } from '../voice/live/store.ts';
import { Composer } from '../components/Composer.tsx';
import type { ComposerHandle } from '../components/Composer.tsx';
import { Turn } from '../components/Thread.tsx';
import { ErrorBox, Link, Spinner } from '../components/ui.tsx';
import { Popover } from '../components/ask/Popover.tsx';
import type { AgentStatus, ConversationSummary } from '../lib/ask.ts';
import { agentName, conversationTurns, runVisibility, useConversation } from '../lib/ask.ts';
import { post } from '../lib/api.ts';
import { shortAge } from '../lib/format.ts';
import { useApi, useNow } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import type { AgentId } from '../lib/types.ts';
import type { PageProps } from '../routes.ts';

const EXAMPLES = [
  'What should I focus on today?',
  'Review my latest code changes and list the risks',
  'Draft a short reply to Sam about the launch date',
  'Compare Plausible and Umami for a small site',
];

function HistoryList({ activeId, onPick }: { activeId: string | null; onPick: () => void }) {
  const [q, setQ] = useState('');
  const list = useApi<{ conversations: ConversationSummary[] }>(`/api/conversations?limit=60${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, ['task.created', 'task.updated', 'run.finished']);
  const now = useNow(60_000);
  return (
    <div className="ask-history-inner">
      <button
        className="btn ask-new"
        onClick={() => {
          navigate('/');
          onPick();
        }}
      >
        <MessageSquarePlus size={16} strokeWidth={1.5} /> New conversation
      </button>
      <label className="ask-search">
        <Search size={14} strokeWidth={1.5} />
        <span className="sr-only">Search conversations</span>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" />
      </label>
      <ul className="ask-history-list">
        {(list.data?.conversations ?? []).map((c) => (
          <li key={c.id}>
            <Link to={`/c/${c.id}`} onClick={onPick} className="ask-history-item" aria-current={c.id === activeId ? 'page' : undefined}>
              <span className="ask-history-title">
                {c.status === 'running' ? <span className="dot live" /> : c.status === 'needs_you' ? <span className="dot" style={{ color: 'var(--warning)' }} /> : null}
                {c.title}
              </span>
              <span className="ask-history-meta">
                {agentName(c.agent)} · {shortAge(c.updated_at, now)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : list.loading ? <span className="ask-loading"><Spinner /> Finding conversations</span> : null}
      {list.data && !list.data.conversations.length ? <p className="ask-history-empty">{q ? 'No conversation matches' : 'Your conversations show here'}</p> : null}
    </div>
  );
}

/**
 * Ask: talk to Claude and Codex on your own plans. Each answer shows the agent's real thinking and
 * steps while it works, then the answer streams in. Pick the agent, model and effort per message.
 */
export default function Ask({ params }: PageProps) {
  const [mode, setMode] = useState<'chat' | 'voice'>(() => {
    try { return localStorage.getItem('jarvis.ask.mode') === 'voice' ? 'voice' : 'chat'; } catch { return 'chat'; }
  });
  const changeMode = (next: 'chat' | 'voice') => { rememberSetting('jarvis.ask.mode', next); setMode(next); };
  useEffect(() => {
    const open = () => changeMode('voice');
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key.toLowerCase() !== 'v' || event.repeat || event.metaKey || event.ctrlKey || event.altKey || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      event.preventDefault(); setMode((current) => { const next = current === 'chat' ? 'voice' : 'chat'; rememberSetting('jarvis.ask.mode', next); return next; });
    };
    window.addEventListener('jarvis.open-voice', open); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('jarvis.open-voice', open); window.removeEventListener('keydown', key); };
  }, []);
  const id = params.id ?? null;
  const { data, error, live, reload } = useConversation(id);
  const agents = useApi<{ agents: Record<AgentId, AgentStatus>; threshold: number }>('/api/agents', ['agents.updated', 'usage.updated', 'run.started', 'run.finished']);
  const [agentOverride, setAgentOverride] = useState<Record<AgentId, AgentStatus> | null>(null);
  const workflowData = useApi<WorkflowList>(id ? `/api/workflows?conversationId=${id}` : null, ['workflow.updated','approval.updated','reconcile']);
  const [panel, setPanel] = useState<'history' | 'agents' | 'workflows' | null>(null);
  const workflowsButton = useRef<HTMLButtonElement>(null);
  const historyButton = useRef<HTMLButtonElement>(null);
  const agentsButton = useRef<HTMLButtonElement>(null);
  const composer = useRef<ComposerHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const now = useNow(1000);
  const setHandle = useCallback((h: ComposerHandle) => { composer.current = h; }, []);

  useEffect(() => setAgentOverride(null), [agents.data]);
  const agentState = agentOverride ?? agents.data?.agents ?? null;

  const turns = conversationTurns(data?.runs ?? []);
  const mainRuns = turns.map((t) => t.run);
  const running = workflowData.data?.runs.some(r => ['running','waiting_approval'].includes(r.status)) || !!data?.active || turns.some((t) => [t.run, ...t.sides, ...t.consults].some((r) => r.status === 'running'));
  const lastAgent = (mainRuns.at(-1)?.agent as AgentId | undefined) ?? null;

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); e.stopImmediatePropagation(); setPanel('history');
        document.querySelector<HTMLInputElement>('.ask-popover .ask-search input')?.focus();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, []);

  // Follow the answer as it streams, unless the owner scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    document.title = data?.conversation ? `${data.conversation.title} · Jarvis` : 'Ask · Jarvis';
  }, [data?.conversation?.title]);

  const stop = async () => {
    const workflow = workflowData.data?.runs.find(r => ['running','waiting_approval'].includes(r.status));
    if (workflow) await post(`/api/workflow-runs/${workflow.id}/cancel`);
    else if (id) await post(`/api/tasks/${id}/cancel`).catch(() => undefined);
  };

  return (
    <div className={`ask${id ? '' : ' empty-thread'}`}>
      <section className="ask-main">
        <div className="ask-top">
          <h1 className="ask-conversation-title" title={data?.conversation.title}>{data?.conversation.title ?? 'Ask'}</h1>
          <nav aria-label="Conversation controls">
            <div className="ask-mode" role="group" aria-label="Conversation mode">{(['chat', 'voice'] as const).map((value) => <button key={value} aria-pressed={mode === value} onClick={() => changeMode(value)}>{value === 'chat' ? 'Chat' : 'Voice'}</button>)}</div>
            <button ref={workflowsButton} className="btn ghost sm" aria-label="Workflows" aria-haspopup="dialog" aria-expanded={panel === 'workflows'} onClick={() => setPanel('workflows')}><GitBranch size={16} strokeWidth={1.5} /><span className="ask-control-label">Workflows</span></button>
            <button ref={historyButton} className="btn ghost sm" aria-label="History" aria-haspopup="dialog" aria-expanded={panel === 'history'} onClick={() => setPanel('history')}><History size={16} strokeWidth={1.5} /><span className="ask-control-label">History</span></button>
            <button ref={agentsButton} className="btn ghost sm" aria-label="Agents" aria-haspopup="dialog" aria-expanded={panel === 'agents'} onClick={() => setPanel('agents')}>
              <span className="ask-agent-dots">{(['claude', 'codex'] as const).map((a) => <span key={a} title={`${agentName(a)}: ${agentState?.[a]?.state ?? 'checking'}`} className={`dot${agentState?.[a]?.state === 'busy' ? ' live' : ''}`} style={{ color: agentState?.[a]?.state === 'busy' ? 'var(--accent)' : agentState?.[a]?.state === 'signed_out' ? 'var(--danger)' : agentState?.[a]?.state === 'limited' ? 'var(--warning)' : 'var(--text-faint)' }} />)}</span><span className="ask-control-label">Agents</span>
            </button>
            <button className="btn ghost sm" aria-label="New conversation" onClick={() => { navigate('/'); composer.current?.fill(''); }}><MessageSquarePlus size={16} strokeWidth={1.5} /><span className="ask-control-label">New</span></button>
          </nav>
        </div>

        {mode === 'voice' ? <VoiceMode conversationId={id} /> : <><div
          className="ask-thread"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {workflowData.data?.runs.slice(0, 1).map(r => <WorkflowProgress key={r.id} run={r} approvals={data?.approvals} onChanged={() => { workflowData.reload(); void reload(); }} />)}
          {error ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}
          {!id ? (
            <div className="ask-welcome">
              <h2>What should we work on?</h2>
              <p>Think it through with Claude and Codex, using your own plans.</p>
              <div className="ask-examples">
                {EXAMPLES.map((e) => (
                  <button key={e} className="ask-example" onClick={() => composer.current?.fill(e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ) : !data && !error ? (
            <div className="ask-loading">
              <Spinner /> Loading the conversation
            </div>
          ) : null}
          {data ? (
            <>
              {turns.map(({ run: r, consults, sides }) => (
                <div key={r.id}>
                <Turn
                  key={r.id}
                  run={r}
                  consults={consults}
                  liveRuns={live}
                  live={live[r.id]}
                  approvals={data.approvals}
                  conversationId={data.conversation.id}
                  last={r.id === mainRuns.at(-1)?.id}
                  now={now}
                  onAskOther={(a) => composer.current?.pick(a)}
                  onDecided={() => void reload()}
                />
                {sides.map((side) => <Turn key={side.id} run={side} live={live[side.id]} consults={data.runs.filter((r) => runVisibility(r) === 'activity' && r.parent_run_id === side.id)} liveRuns={live} approvals={data.approvals} conversationId={data.conversation.id} last={false} now={now} onAskOther={(a) => composer.current?.pick(a)} onDecided={() => void reload()} />)}
                </div>
              ))}
            </>
          ) : null}
        </div>

        <div className="ask-composer">
          <Composer
            key={id ?? 'new'}
            conversationId={id}
            running={running}
            lastAgent={lastAgent}
            agents={agentState}
            handle={setHandle}
            placeholder={id ? `Reply${lastAgent ? ` to ${agentName(lastAgent)}` : ''}` : undefined}
            onSent={(cid) => {
              stick.current = true;
              if (cid !== id) navigate(`/c/${cid}`);
              else void reload();
            }}
            onStop={() => void stop()}
          />
        </div>
        </>}
      </section>
      {panel ? (
        <Popover title={panel === 'history' ? 'History' : panel === 'workflows' ? 'Workflows' : 'Agents'} anchor={panel === 'history' ? historyButton.current : panel === 'workflows' ? workflowsButton.current : agentsButton.current} search={panel === 'history'} onClose={() => setPanel(null)}>
          {panel === 'workflows' ? <WorkflowMenu conversationId={id ?? undefined} onStarted={() => { setPanel(null); workflowData.reload(); void reload(); }} /> : panel === 'history' ? <HistoryList activeId={id} onPick={() => setPanel(null)} /> : <><AgentStrip agents={agentState} threshold={agents.data?.threshold ?? 85} picked="" onPick={(a) => { setPanel(null); requestAnimationFrame(() => composer.current?.pick(a)); }} onRefreshed={setAgentOverride} /><VoiceUsage /></>}
        </Popover>
      ) : null}
    </div>
  );
}
