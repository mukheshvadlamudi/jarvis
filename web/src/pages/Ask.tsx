import { History, MessageSquarePlus, Search } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AgentStrip } from '../components/AgentStrip.tsx';
import { Composer } from '../components/Composer.tsx';
import type { ComposerHandle } from '../components/Composer.tsx';
import { Turn } from '../components/Thread.tsx';
import { ErrorBox, Link, Sheet, Spinner } from '../components/ui.tsx';
import type { AgentStatus, ConversationSummary } from '../lib/ask.ts';
import { agentName, sideLabel, useConversation } from '../lib/ask.ts';
import { post } from '../lib/api.ts';
import { shortAge } from '../lib/format.ts';
import { useApi, useMedia, useNow } from '../lib/hooks.ts';
import { navigate } from '../lib/router.ts';
import type { AgentId } from '../lib/types.ts';
import type { PageProps } from '../routes.ts';

const EXAMPLES = [
  'What did I decide about the ClientEasy backups?',
  'Review the auth middleware in ClientEasy and list the risks',
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
            <Link to={`/c/${c.id}`} className="ask-history-item" aria-current={c.id === activeId ? 'page' : undefined}>
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
      {list.data && !list.data.conversations.length ? <p className="ask-history-empty">{q ? 'No conversation matches' : 'Your conversations show here'}</p> : null}
    </div>
  );
}

/**
 * Ask: talk to Claude and Codex on your own plans. Each answer shows the agent's real thinking and
 * steps while it works, then the answer streams in. Pick the agent, model and effort per message.
 */
export default function Ask({ params }: PageProps) {
  const id = params.id ?? null;
  const { data, error, live, reload } = useConversation(id);
  const agents = useApi<{ agents: Record<AgentId, AgentStatus>; threshold: number }>('/api/agents', ['agents.updated', 'usage.updated', 'run.started', 'run.finished']);
  const [agentOverride, setAgentOverride] = useState<Record<AgentId, AgentStatus> | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const wide = useMedia('(min-width: 1024px)');
  const composer = useRef<ComposerHandle | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const now = useNow(1000);
  const setHandle = useCallback((h: ComposerHandle) => (composer.current = h), []);

  useEffect(() => setAgentOverride(null), [agents.data]);
  const agentState = agentOverride ?? agents.data?.agents ?? null;

  const runs = data?.runs ?? [];
  const running = !!data?.active || runs.some((r) => r.status === 'running' && !sideLabel(r));
  const mainRuns = runs.filter((r) => !sideLabel(r));
  const lastAgent = (mainRuns.at(-1)?.agent as AgentId | undefined) ?? null;

  // Follow the answer as it streams, unless the owner scrolled up to read.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    document.title = data?.conversation ? `${data.conversation.title} · Jarvis` : 'Ask · Jarvis';
  }, [data?.conversation?.title]);

  const stop = async () => {
    if (id) await post(`/api/tasks/${id}/cancel`).catch(() => undefined);
  };

  return (
    <div className={`ask${id ? '' : ' empty-thread'}`}>
      {wide ? (
        <aside className="ask-history" aria-label="Conversations">
          <HistoryList activeId={id} onPick={() => undefined} />
        </aside>
      ) : null}
      <section className="ask-main">
        <div className="ask-top">
          {!wide ? (
            <button className="btn ghost sm" onClick={() => setHistoryOpen(true)} aria-label="Conversations">
              <History size={16} strokeWidth={1.5} />
            </button>
          ) : null}
          <AgentStrip
            agents={agentState}
            threshold={agents.data?.threshold ?? 85}
            picked=""
            onPick={(a) => composer.current?.pick(a)}
            onRefreshed={(a) => setAgentOverride(a)}
          />
        </div>

        <div
          className="ask-thread"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {error ? <ErrorBox error={error} onRetry={() => void reload()} /> : null}
          {!id ? (
            <div className="ask-welcome">
              <h1>What should Claude or Codex do?</h1>
              <p>Ask a question and it is answered right here, using your Claude and ChatGPT plans. You see what the agent is checking while it works.</p>
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
              <h1 className="ask-title">{data.conversation.title}</h1>
              {runs.map((r) => (
                <Turn
                  key={r.id}
                  run={r}
                  live={live[r.id]}
                  approvals={data.approvals}
                  conversationId={data.conversation.id}
                  last={r.id === mainRuns.at(-1)?.id}
                  now={now}
                  onAskOther={(a) => composer.current?.pick(a)}
                  onDecided={() => void reload()}
                />
              ))}
            </>
          ) : null}
        </div>

        <div className="ask-composer">
          <Composer
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
      </section>
      {historyOpen ? (
        <Sheet title="Conversations" onClose={() => setHistoryOpen(false)}>
          <HistoryList activeId={id} onPick={() => setHistoryOpen(false)} />
        </Sheet>
      ) : null}
    </div>
  );
}
