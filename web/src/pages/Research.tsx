import { FlaskConical, Plus, Send } from 'lucide-react';
import { useState } from 'react';
import { CaptureSheet } from '../components/CommandBar.tsx';
import { AgentBadge, Empty, ErrorBox, Link, PageHead, Sheet, Skeleton, SkeletonRows, StatusLabel, TextInput } from '../components/ui.tsx';
import { post } from '../lib/api.ts';
import { tokens } from '../lib/format.ts';
import { useApi, useMedia } from '../lib/hooks.ts';
import { Highlight, Markdown } from '../lib/markdown.tsx';
import { navigate, setQuery, useLocation } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Task } from '../lib/types.ts';

interface Report {
  path: string;
  title: string;
  updated: string;
  project: string | null;
  tokens: number;
  task: { id: string; status: string } | null;
  agent: 'claude' | 'codex' | null;
  snippet: string | null;
}

function Reader({ r }: { r: Report }) {
  const note = useApi<{ note: { body: string; frontmatter: Record<string, unknown> } }>(`/api/memory/note?path=${encodeURIComponent(r.path)}`, ['memory.updated']);
  const [q, setQ] = useState('');
  const [sending, setSending] = useState(false);
  const ask = async () => {
    if (!r.task || !q.trim()) return;
    setSending(true);
    try {
      await post(`/api/tasks/${r.task.id}/followup`, { text: q.trim() });
      setQ('');
      toast('Follow-up sent — the same research session continues and updates this report.', { kind: 'success', action: { label: 'Watch', run: () => navigate(`/tasks/${r.task!.id}`) } });
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
    }
  };
  return (
    <article>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16, fontSize: 12 }}>
        <span className="mono faint">{r.path}</span>
        {r.project ? <span className="chip">{r.project}</span> : null}
        {r.agent ? <AgentBadge agent={r.agent} /> : null}
        {r.task ? (
          <Link to={`/tasks/${r.task.id}`} className="faint">
            run →
          </Link>
        ) : null}
      </div>
      {note.error ? <ErrorBox error={note.error} /> : null}
      {note.data ? <Markdown source={note.data.note.body} onWiki={(t) => navigate(`/memory?note=${encodeURIComponent(t)}`)} /> : <Skeleton />}
      {r.task ? (
        <form
          style={{ marginTop: 24, display: 'flex', gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void ask();
          }}
        >
          <div style={{ flex: 1 }}>
            <TextInput value={q} onValue={setQ} placeholder="Ask a follow-up question about this report" aria-label="Follow-up question" />
          </div>
          <button className="btn primary icon" type="submit" aria-label="Send follow-up" disabled={!q.trim() || sending}>
            <Send size={14} strokeWidth={1.5} />
          </button>
        </form>
      ) : (
        <p className="faint" style={{ fontSize: 12, marginTop: 24 }}>
          Written outside Jarvis, so there is no session to continue. Start a new research task to dig deeper.
        </p>
      )}
    </article>
  );
}

export default function Research() {
  const { query } = useLocation();
  const [q, setQ] = useState(query.get('q') ?? '');
  const [capture, setCapture] = useState(false);
  const res = useApi<{ reports: Report[]; running: Task[] }>(`/api/research${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`, ['memory.updated', 'task.updated']);
  const selected = query.get('report');
  const desktop = useMedia('(min-width: 1024px)');
  const reports = res.data?.reports ?? [];
  const current = reports.find((r) => r.path === selected) ?? (desktop ? reports[0] : undefined);

  return (
    <div className="page wide">
      <PageHead title="Research" sub={res.data ? `${reports.length} report${reports.length === 1 ? '' : 's'} in Research/` : undefined}>
        <button className="btn primary" onClick={() => setCapture(true)}>
          <Plus size={14} strokeWidth={1.5} /> New research
        </button>
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
      <div style={{ marginBottom: 16, maxWidth: 520 }}>
        <TextInput value={q} onValue={setQ} placeholder="Search reports" aria-label="Search reports" />
      </div>

      {res.data?.running.length ? (
        <div className="panel" style={{ marginBottom: 16 }}>
          {res.data.running.map((t) => (
            <Link key={t.id} to={`/tasks/${t.id}`} className="row">
              <StatusLabel status={t.status} />
              <span className="title">{t.title}</span>
              <span className="faint hide-sm" style={{ fontSize: 12 }}>report lands here when it finishes</span>
            </Link>
          ))}
        </div>
      ) : null}

      <div className={desktop ? 'split' : ''}>
        <div className="panel" style={{ minWidth: 0 }}>
          {res.loading ? <SkeletonRows rows={4} /> : null}
          {!res.loading && !reports.length ? (
            <Empty
              title={q.trim() ? `No reports mention “${q.trim()}”.` : 'No research reports yet.'}
              action={
                <button className="btn" onClick={() => setCapture(true)}>
                  <FlaskConical size={14} strokeWidth={1.5} /> Start one
                </button>
              }
            >
              Research tasks run with live web search and save a report with sources to Research/ in your vault.
            </Empty>
          ) : null}
          <ul className="list">
            {reports.map((r) => (
              <li key={r.path}>
                <button className={`row${current?.path === r.path ? ' selected' : ''}`} onClick={() => setQuery({ report: r.path })} style={{ alignItems: 'flex-start' }}>
                  <div className="row-stack">
                    <span className="title" style={{ whiteSpace: 'normal' }}>{r.title}</span>
                    {r.snippet ? (
                      <span className="sub" style={{ whiteSpace: 'normal' }}>
                        <Highlight text={r.snippet} />
                      </span>
                    ) : (
                      <span className="sub">{[r.project, `${tokens(r.tokens)} tokens`].filter(Boolean).join(' · ')}</span>
                    )}
                  </div>
                  <span className="time">{r.updated}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {desktop ? (
          <div className="panel detail-pane">
            <div className="panel-body" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
              {current ? <Reader key={current.path} r={current} /> : <Empty title="Pick a report to read it" />}
            </div>
          </div>
        ) : current ? (
          <Sheet title={current.title} onClose={() => setQuery({ report: null })} wide>
            <Reader r={current} />
          </Sheet>
        ) : null}
      </div>
      {capture ? <CaptureSheet onClose={() => setCapture(false)} /> : null}
    </div>
  );
}
