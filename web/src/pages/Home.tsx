import { ArrowRight, Clock3 } from 'lucide-react';
import { useState } from 'react';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { CommandBar } from '../components/CommandBar.tsx';
import { Systems } from '../components/Systems.tsx';
import { SetupBanner } from '../components/SetupBanner.tsx';
import { UsageMeters } from '../components/UsageMeters.tsx';
import { AgentBadge, Empty, ErrorBox, Link, SkeletonRows, StatusLabel } from '../components/ui.tsx';
import { homeSections } from '../homeSections.ts';
import { relTime, shortAge, TYPE_LABEL } from '../lib/format.ts';
import { useApi, useNow } from '../lib/hooks.ts';
import { useLive } from '../lib/live.ts';
import type { Approval, Task } from '../lib/types.ts';

function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function Home() {
  const active = useApi<{ tasks: Task[] }>('/api/tasks?status=running,needs_you,queued&limit=50', ['task.*', 'run.started', 'run.finished']);
  const recent = useApi<{ tasks: Task[] }>('/api/tasks?status=done,failed&limit=6', ['task.updated', 'run.finished']);
  const approvals = useApi<{ approvals: Approval[]; pending: number }>('/api/approvals?status=pending', ['approval.*']);
  const [activity, setActivity] = useState<Record<string, string>>({});
  const now = useNow(15_000);

  useLive(['run.event'], (e) => {
    const p = e.data?.payload ?? {};
    let line: string | null = null;
    if (e.data?.kind === 'message' && p.role !== 'user') line = String(p.text ?? '');
    else if (e.data?.kind === 'tool_call') line = `${p.tool}: ${p.summary ?? p.input?.command ?? p.input?.file_path ?? p.input?.query ?? ''}`;
    else if (e.data?.kind === 'status' && p.status === 'waiting_approval') line = `Waiting for approval: ${p.summary}`;
    if (line && e.data?.taskId) setActivity((a) => ({ ...a, [e.data.taskId]: line!.split('\n')[0].slice(0, 160) }));
  });

  const tasks = active.data?.tasks ?? [];
  const running = tasks.filter((t) => t.status === 'running');
  const queued = tasks.filter((t) => t.status === 'queued');
  const pendingTaskIds = new Set((approvals.data?.approvals ?? []).map((a) => a.task_id));
  const blocked = tasks.filter((t) => t.status === 'needs_you' && !pendingTaskIds.has(t.id));
  const needsYouCount = (approvals.data?.pending ?? 0) + blocked.length;

  return (
    <div className="page">
      <header className="hero-greeting">
        <span className="eyebrow">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {running.length ? `${running.length} running` : 'all systems idle'}
          {needsYouCount ? ` · ${needsYouCount} awaiting you` : ''}
        </span>
        <h1>{greeting()}.</h1>
      </header>
      <SetupBanner />
      <Systems />

      <CommandBar />

      <div className="home-grid" style={{ marginTop: 24 }}>
        <div style={{ minWidth: 0 }}>
          <section className="section" aria-labelledby="needs-you">
            <div className="section-head">
              <h2 className="section-title" id="needs-you">
                Needs you
              </h2>
              <span className="count">{needsYouCount}</span>
              {approvals.data && approvals.data.pending > 2 ? (
                <Link to="/approvals" className="right faint" title="All approvals">
                  <span style={{ fontSize: 12 }}>All approvals →</span>
                </Link>
              ) : null}
            </div>
            <div className="panel">
              {approvals.error ? <div className="panel-body"><ErrorBox error={approvals.error} onRetry={approvals.reload} /></div> : null}
              {approvals.loading || active.loading ? <SkeletonRows rows={2} /> : null}
              {!approvals.loading && needsYouCount === 0 ? (
                <Empty title="You’re clear.">Approvals and blocked tasks land here — agents pause until you decide.</Empty>
              ) : null}
              {(approvals.data?.approvals ?? []).slice(0, 2).map((a) => (
                <ApprovalCard key={a.id} a={a} compact onDecided={approvals.reload} />
              ))}
              {blocked.map((t) => (
                <Link key={t.id} to={`/tasks/${t.id}`} className="row">
                  <StatusLabel status={t.status} />
                  <div className="row-stack">
                    <span className="title">{t.title}</span>
                    <span className="sub">{t.result_summary ?? 'Waiting on you'}</span>
                  </div>
                  <span className="time">{shortAge(t.updated_at, now)}</span>
                </Link>
              ))}
            </div>
          </section>

          <section className="section" aria-labelledby="running-now">
            <div className="section-head">
              <h2 className="section-title" id="running-now">
                Running now
              </h2>
              <span className="count">{running.length + queued.length}</span>
              <Link to="/board" className="right faint">
                <span style={{ fontSize: 12 }}>Board →</span>
              </Link>
            </div>
            <div className="panel">
              {active.error ? <div className="panel-body"><ErrorBox error={active.error} onRetry={active.reload} /></div> : null}
              {active.loading ? <SkeletonRows rows={3} /> : null}
              {!active.loading && running.length + queued.length === 0 ? (
                <Empty title="No agents are working.">Type a task above and press Enter — it starts as soon as a slot is free (2 at a time).</Empty>
              ) : null}
              <ul className="list">
                {running.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="row">
                      <StatusLabel status="running" />
                      <div className="row-stack">
                        <span className="title">{t.title}</span>
                        <span className="sub mono" style={{ fontSize: 12 }}>
                          {activity[t.id] ?? t.route_reason ?? 'Starting…'}
                        </span>
                      </div>
                      <span className="meta">
                        <AgentBadge agent={t.agent} reason={t.route_reason} />
                        <span className="time">{shortAge(t.updated_at, now)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
                {queued.map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="row">
                      <StatusLabel status="queued" />
                      <div className="row-stack">
                        <span className="title">{t.title}</span>
                        <span className="sub">
                          {t.not_before ? (
                            <>
                              <Clock3 size={12} strokeWidth={1.5} style={{ verticalAlign: -2 }} /> {t.route_reason} · retries {relTime(t.not_before, now)}
                            </>
                          ) : (
                            `${TYPE_LABEL[t.type]} · waiting for a free slot`
                          )}
                        </span>
                      </div>
                      <span className="time">{shortAge(t.created_at, now)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {homeSections.filter((s) => s.column === 'main').map((S) => (
            <S.component key={S.id} />
          ))}

          <section className="section" aria-labelledby="recent">
            <div className="section-head">
              <h2 className="section-title" id="recent">
                Recently finished
              </h2>
            </div>
            <div className="panel">
              {recent.loading ? <SkeletonRows rows={4} /> : null}
              {!recent.loading && !recent.data?.tasks.length ? <Empty title="Nothing finished yet.">Completed and failed tasks show here with their result.</Empty> : null}
              <ul className="list">
                {(recent.data?.tasks ?? []).map((t) => (
                  <li key={t.id}>
                    <Link to={`/tasks/${t.id}`} className="row">
                      <StatusLabel status={t.status} />
                      <div className="row-stack">
                        <span className="title">{t.title}</span>
                        <span className="sub">{t.result_summary}</span>
                      </div>
                      <span className="time">{shortAge(t.updated_at, now)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>

        <aside style={{ minWidth: 0 }}>
          <section className="section" aria-labelledby="plan-usage">
            <div className="section-head">
              <h2 className="section-title" id="plan-usage">
                Plan usage
              </h2>
              <Link to="/usage" className="right faint">
                <span style={{ fontSize: 12 }}>
                  Details <ArrowRight size={12} style={{ verticalAlign: -2 }} />
                </span>
              </Link>
            </div>
            <div className="panel panel-body">
              <UsageMeters />
            </div>
          </section>
          {homeSections.filter((s) => s.column === 'side').map((S) => (
            <S.component key={S.id} />
          ))}
        </aside>
      </div>
    </div>
  );
}
