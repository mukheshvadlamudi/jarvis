import { CalendarCheck, Mail } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorBox, Link, PageHead, SkeletonRows } from '../components/ui.tsx';
import { post } from '../lib/api.ts';
import { relTime } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import { toast, toastError } from '../lib/toast.ts';

interface Person {
  path: string;
  name: string;
  company: string | null;
  role: string | null;
  email: string | null;
  last_contact: string | null;
  follow_up: string | null;
  tags: string[];
  openThreads: string[];
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const addDays = (n: number) => {
  const d = new Date(Date.now() + n * 86400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function due(p: Person): { label: string; tone: 'danger' | 'warn' | '' } | null {
  if (!p.follow_up) return null;
  const t = todayIso();
  if (p.follow_up < t) return { label: `overdue since ${p.follow_up}`, tone: 'danger' };
  if (p.follow_up === t) return { label: 'follow up today', tone: 'warn' };
  return { label: `follow up ${relTime(`${p.follow_up}T09:00:00`)}`, tone: '' };
}

function PersonCard({ p, reload }: { p: Person; reload: () => void }) {
  const [date, setDate] = useState(p.follow_up ?? '');
  const d = due(p);
  const touch = async (body: { contacted?: boolean; followUp?: string | null }, msg: string) => {
    try {
      await post('/api/people/touch', { path: p.path, ...body });
      toast(msg, { kind: 'success' });
      reload();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <article className="approval" aria-label={p.name}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <Link to={`/memory?note=${encodeURIComponent(p.path)}`} className="approval-what">
          {p.name}
        </Link>
        <span className="muted" style={{ fontSize: 13 }}>{[p.role, p.company].filter(Boolean).join(' · ')}</span>
        {d ? <span className={`chip ${d.tone}`} style={{ marginLeft: 'auto' }}>{d.label}</span> : null}
      </div>
      {p.openThreads.length ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {p.openThreads.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      ) : (
        <span className="faint" style={{ fontSize: 13 }}>No open threads listed.</span>
      )}
      <div className="approval-meta">
        <span>last contact {p.last_contact ?? 'unknown'}</span>
        {p.email ? (
          <span>
            <Mail size={12} strokeWidth={1.5} style={{ verticalAlign: -2 }} /> {p.email}
          </span>
        ) : null}
        {p.tags.map((t) => (
          <span key={t} className="mono">#{t}</span>
        ))}
      </div>
      <div className="approval-actions">
        <button className="btn sm" onClick={() => void touch({ contacted: true, followUp: null }, `Marked ${p.name} as contacted today`)}>
          <CalendarCheck size={14} strokeWidth={1.5} /> Contacted today
        </button>
        <button className="btn sm ghost" onClick={() => void touch({ followUp: addDays(7) }, `Follow-up with ${p.name} moved to next week`)}>
          Snooze a week
        </button>
        <label className="sr-only" htmlFor={`fu-${p.path}`}>
          Next follow-up
        </label>
        <input
          id={`fu-${p.path}`}
          type="date"
          className="input mono"
          style={{ width: 150, flex: 'none' }}
          value={date}
          onChange={(e) => setDate(e.target.value)}
          onBlur={() => date !== (p.follow_up ?? '') && void touch({ followUp: date || null }, date ? `Next follow-up: ${date}` : 'Follow-up cleared')}
        />
      </div>
    </article>
  );
}

export default function People() {
  const res = useApi<{ people: Person[] }>('/api/people', ['memory.updated']);
  const list = res.data?.people ?? [];
  const t = todayIso();
  const dueNow = list.filter((p) => p.follow_up && p.follow_up <= addDays(7));
  const rest = list.filter((p) => !dueNow.includes(p));
  return (
    <div className="page">
      <PageHead
        title="People"
        sub={res.data ? `${list.filter((p) => p.follow_up && p.follow_up <= t).length ? `${list.filter((p) => p.follow_up && p.follow_up <= t).length} due now` : `${dueNow.length} due this week`} · from People/*.md` : undefined}
      />
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
      {res.loading ? (
        <div className="panel">
          <SkeletonRows rows={3} />
        </div>
      ) : null}
      {!res.loading && !list.length ? (
        <div className="panel">
          <Empty title="No people notes yet.">Add notes under People/ with frontmatter like company, role, last_contact and follow_up (YYYY-MM-DD). The morning brief lists anyone due.</Empty>
        </div>
      ) : null}
      {dueNow.length ? (
        <section className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-head">
            <h2>Due this week</h2>
            <span className="count">{dueNow.length}</span>
          </div>
          {dueNow.map((p) => (
            <PersonCard key={p.path} p={p} reload={res.reload} />
          ))}
        </section>
      ) : null}
      {rest.length ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Everyone else</h2>
            <span className="count">{rest.length}</span>
          </div>
          {rest.map((p) => (
            <PersonCard key={p.path} p={p} reload={res.reload} />
          ))}
        </section>
      ) : null}
    </div>
  );
}
