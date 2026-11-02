import { useEffect, useRef } from 'react';
import { ApprovalCard } from '../components/ApprovalCard.tsx';
import { Empty, ErrorBox, PageHead, Segmented, SkeletonRows } from '../components/ui.tsx';
import { useApi } from '../lib/hooks.ts';
import { setQuery, useLocation } from '../lib/router.ts';
import type { Approval } from '../lib/types.ts';

export default function Approvals() {
  const { query } = useLocation();
  const view = (query.get('view') as 'pending' | 'history') ?? 'pending';
  const res = useApi<{ approvals: Approval[]; pending: number }>(view === 'pending' ? '/api/approvals?status=pending' : '/api/approvals', ['approval.*']);
  const list = (res.data?.approvals ?? []).filter((a) => (view === 'pending' ? a.status === 'pending' : a.status !== 'pending'));
  const ref = useRef<HTMLDivElement>(null);

  // j/k move focus between approval cards.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || e.metaKey || e.ctrlKey) return;
      if (e.key !== 'j' && e.key !== 'k') return;
      const cards = [...(ref.current?.querySelectorAll<HTMLElement>('.approval') ?? [])];
      if (!cards.length) return;
      const idx = cards.findIndex((c) => c.contains(document.activeElement));
      const next = cards[Math.max(0, Math.min(cards.length - 1, idx + (e.key === 'j' ? 1 : -1)))];
      next.tabIndex = -1;
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="page">
      <PageHead title="Approvals" sub={res.data ? `${res.data.pending} pending · expire after 24 h` : undefined}>
        <Segmented
          label="View"
          value={view}
          onChange={(v) => setQuery({ view: v === 'pending' ? null : v })}
          options={[
            { value: 'pending', label: 'Pending' },
            { value: 'history', label: 'History' },
          ]}
        />
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
      <div className="panel" ref={ref}>
        {res.loading ? <SkeletonRows rows={3} /> : null}
        {!res.loading && !list.length ? (
          view === 'pending' ? (
            <Empty title="Nothing waiting for you">
              Pushes, PRs, emails, posts, purchases and deletes outside a task folder pause here until you approve them — from this page or Telegram.
            </Empty>
          ) : (
            <Empty title="No decisions yet">Approved, rejected and expired requests are kept here for reference.</Empty>
          )
        ) : null}
        {list.map((a) => (
          <ApprovalCard key={a.id} a={a} onDecided={res.reload} />
        ))}
      </div>
    </div>
  );
}
