import { CalendarClock, UserRound } from 'lucide-react';
import { useApi, useNow } from '../lib/hooks.ts';
import { Empty, Link, SkeletonRows } from './ui.tsx';

interface Today {
  upcoming: Array<{ id: string; name: string; at: string }>;
  ranToday: Array<{ id: number; name: string; ts: string; kind: string; task_id: string | null; task_status: string | null }>;
  followUps: Array<{ path: string; title: string; follow_up: string }>;
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Home side column: today's scheduled routines and follow-ups due. */
export function TodaySection() {
  const res = useApi<Today>('/api/schedules/today', ['schedule.*', 'memory.updated']);
  useNow(60_000);
  const d = res.data;
  const today = new Date().toISOString().slice(0, 10);
  return (
    <>
      <section className="section" aria-labelledby="today-schedule">
        <div className="section-head">
          <h2 className="section-title" id="today-schedule">
            Today
          </h2>
          <Link to="/schedules" className="right faint">
            <span style={{ fontSize: 12 }}>Schedules →</span>
          </Link>
        </div>
        <div className="panel">
          {!d ? <SkeletonRows rows={2} /> : null}
          {d && !d.upcoming.length && !d.ranToday.length ? (
            <Empty title="No routines today.">
              Turn on the Morning brief or add your own in <Link to="/schedules" className="muted">Schedules</Link>.
            </Empty>
          ) : null}
          <ul className="list">
            {d?.ranToday.slice(0, 4).map((r) => (
              <li key={`r${r.id}`}>
                <Link to={r.task_id ? `/tasks/${r.task_id}` : '/schedules'} className="row">
                  <span className="time" style={{ minWidth: 40 }}>{hhmm(r.ts)}</span>
                  <span className="title" style={{ fontWeight: 400 }}>{r.name}</span>
                  <span className="faint" style={{ fontSize: 12 }}>{r.task_status === 'done' ? 'done' : r.kind === 'missed' ? 'caught up' : r.task_status ?? r.kind}</span>
                </Link>
              </li>
            ))}
            {d?.upcoming.slice(0, 5).map((u) => (
              <li key={`u${u.id}${u.at}`}>
                <Link to="/schedules" className="row">
                  <span className="time" style={{ minWidth: 40, color: 'var(--text)' }}>{hhmm(u.at)}</span>
                  <span className="title" style={{ fontWeight: 400 }}>{u.name}</span>
                  <CalendarClock size={14} strokeWidth={1.5} color="var(--text-faint)" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <section className="section" aria-labelledby="follow-ups">
        <div className="section-head">
          <h2 className="section-title" id="follow-ups">
            Follow-ups
          </h2>
          <span className="count">{d?.followUps.length ?? ''}</span>
        </div>
        <div className="panel">
          {!d ? <SkeletonRows rows={2} /> : null}
          {d && !d.followUps.length ? <Empty title="Nothing due this week.">Set <code>follow_up: YYYY-MM-DD</code> in a People note’s frontmatter to see it here.</Empty> : null}
          <ul className="list">
            {d?.followUps.map((f) => (
              <li key={f.path}>
                <Link to={`/memory?note=${encodeURIComponent(f.path)}`} className="row">
                  <UserRound size={14} strokeWidth={1.5} color="var(--text-faint)" />
                  <span className="title" style={{ fontWeight: 400 }}>{f.title}</span>
                  <span className="time" style={f.follow_up < today ? { color: 'var(--warning)' } : undefined}>
                    {f.follow_up === today ? 'today' : f.follow_up < today ? `overdue · ${f.follow_up.slice(5)}` : `${new Date(`${f.follow_up}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })} ${Number(f.follow_up.slice(8))}`}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </>
  );
}
