import { AlertTriangle, ClipboardCopy, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Empty, ErrorBox, Link, PageHead, Segmented, Sheet, Skeleton, SkeletonRows, TextInput } from '../components/ui.tsx';
import { api, post } from '../lib/api.ts';
import { relTime, tokens } from '../lib/format.ts';
import { useApi, useMedia } from '../lib/hooks.ts';
import { Highlight, Markdown } from '../lib/markdown.tsx';
import { navigate, setQuery, useLocation } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';

interface NoteRow {
  path: string;
  title: string;
  type: string | null;
  tokens: number;
  updated: string | null;
  tags: string | null;
}
interface Hit {
  path: string;
  title: string;
  type: string | null;
  snippet: string;
  tokens: number;
}
interface Note {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
  body: string;
  tokens: number;
  mtime: number;
}
interface Proposal {
  id: string;
  run_id: string | null;
  target_path: string;
  diff: string;
  reason: string;
  status: string;
  created_at: string;
  mode: string;
  error: string | null;
}
interface Overview {
  vault: string;
  demoCopy: boolean;
  notes: number;
  fts: boolean;
  byType: Record<string, number>;
  coreTokens: number | null;
  caps: { core: number; project: number; context: number };
  sizes: Array<{ path: string; tokens: number; cap: number; kind: string }>;
  pending: number;
}
interface MigrationItem {
  action: 'create' | 'move' | 'merge' | 'trim';
  from: string | null;
  to: string;
  reason: string;
}

const GROUPS: Array<{ label: string; match: (p: string) => boolean }> = [
  { label: 'Core', match: (p) => p === 'CORE.md' || p === 'Inbox.md' },
  { label: 'Projects', match: (p) => p.startsWith('Projects/') },
  { label: 'People', match: (p) => p.startsWith('People/') },
  { label: 'Areas', match: (p) => p.startsWith('Areas/') },
  { label: 'Research', match: (p) => p.startsWith('Research/') },
  { label: 'Skills', match: (p) => p.startsWith('Skills/') },
  { label: 'Journal', match: (p) => p.startsWith('Journal/') },
  { label: 'Unfiled', match: () => true },
];

export function Diff({ text }: { text: string }) {
  if (!text) return <p className="faint" style={{ fontSize: 12 }}>No textual change.</p>;
  return (
    <div className="diff" role="region" aria-label="Diff">
      {text
        .split('\n')
        .filter((l) => l !== '')
        .map((l, i) => (
          <div key={i} className={l.startsWith('+++') || l.startsWith('---') ? 'faint' : l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>
            {l || ' '}
          </div>
        ))}
    </div>
  );
}

function capFor(path: string, caps: Overview['caps'] | undefined): number | null {
  if (!caps) return null;
  if (path === 'CORE.md') return caps.core;
  if (path.startsWith('Projects/')) return caps.project;
  return null;
}

function NoteView({ path, caps, onOpen }: { path: string; caps?: Overview['caps']; onOpen: (p: string) => void }) {
  const res = useApi<{ note: Note }>(`/api/memory/note?path=${encodeURIComponent(path)}`, ['memory.updated']);
  if (res.error) return <ErrorBox error={res.error} />;
  if (!res.data)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Skeleton w="50%" h={18} />
        <Skeleton />
        <Skeleton w="80%" />
      </div>
    );
  const n = res.data.note;
  const cap = capFor(n.path, caps);
  const fm = Object.entries(n.frontmatter).filter(([k]) => !['title'].includes(k));
  return (
    <article>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12, fontSize: 12 }}>
        <span className="mono faint">{n.path}</span>
        <span className={`chip${cap && n.tokens > cap ? ' danger' : ''}`}>
          {tokens(n.tokens)} tokens{cap ? ` / ${tokens(cap)} cap` : ''}
        </span>
        <span className="faint">edited {relTime(new Date(n.mtime).toISOString())}</span>
      </div>
      {fm.length ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
          {fm.map(([k, v]) => (
            <span key={k} className="chip">
              <span className="faint">{k}</span> {Array.isArray(v) ? v.join(', ') : String(v)}
            </span>
          ))}
        </div>
      ) : null}
      <Markdown source={n.body} onWiki={(t) => onOpen(t)} />
    </article>
  );
}

function SearchTab({ overview }: { overview: Overview | null }) {
  const { query } = useLocation();
  const [q, setQ] = useState(query.get('q') ?? '');
  const [debounced, setDebounced] = useState(q);
  const selected = query.get('note');
  const desktop = useMedia('(min-width: 1024px)');
  const [capture, setCapture] = useState('');

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(q.trim()), 200);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setQuery({ q: debounced || null });
  }, [debounced]);

  const hits = useApi<{ results: Hit[] }>(debounced ? `/api/memory/search?q=${encodeURIComponent(debounced)}&limit=30` : null, ['memory.updated']);
  const notes = useApi<{ notes: NoteRow[] }>(debounced ? null : '/api/memory/notes', ['memory.updated']);
  const open = (p: string) => setQuery({ note: p });

  const grouped = useMemo(() => {
    const rows = notes.data?.notes ?? [];
    const used = new Set<string>();
    return GROUPS.map((g) => {
      const items = rows.filter((r) => !used.has(r.path) && g.match(r.path));
      items.forEach((r) => used.add(r.path));
      return { label: g.label, items };
    }).filter((g) => g.items.length);
  }, [notes.data]);

  const list = debounced ? (
    hits.loading ? (
      <SkeletonRows rows={5} />
    ) : !hits.data?.results.length ? (
      <Empty title={`Nothing matches “${debounced}”.`}>Try fewer words, or a person or project name. Search covers every note except .obsidian and attachments.</Empty>
    ) : (
      <ul className="list">
        {hits.data.results.map((h) => (
          <li key={h.path}>
            <button className={`row${selected === h.path ? ' selected' : ''}`} onClick={() => open(h.path)} style={{ alignItems: 'flex-start' }}>
              <FileText size={14} strokeWidth={1.5} style={{ marginTop: 3, flex: 'none' }} color="var(--text-faint)" />
              <div className="row-stack">
                <span className="title">{h.title}</span>
                <span className="sub" style={{ whiteSpace: 'normal' }}>
                  <Highlight text={h.snippet} />
                </span>
                <span className="mono faint" style={{ fontSize: 11 }}>
                  {h.path}
                </span>
              </div>
              <span className="time">{tokens(h.tokens)}</span>
            </button>
          </li>
        ))}
      </ul>
    )
  ) : notes.loading ? (
    <SkeletonRows rows={8} />
  ) : (
    <div>
      {grouped.map((g) => (
        <div key={g.label}>
          <div className="nav-section" style={{ margin: '12px 16px 4px' }}>
            {g.label} <span className="mono">{g.items.length}</span>
          </div>
          <ul className="list">
            {g.items.map((n) => {
              const cap = capFor(n.path, overview?.caps);
              return (
                <li key={n.path}>
                  <button className={`row${selected === n.path ? ' selected' : ''}`} onClick={() => open(n.path)} style={{ minHeight: 36, paddingTop: 4, paddingBottom: 4 }}>
                    <span className="title" style={{ fontWeight: 400, fontSize: 13 }}>
                      {n.path.startsWith('Journal/') || n.path.startsWith('Skills/') ? n.path.split('/').slice(-2).join('/') : n.title}
                    </span>
                    <span className="time" style={cap && n.tokens > cap ? { color: 'var(--danger)' } : undefined}>
                      {tokens(n.tokens)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', position: 'relative' }}>
          <TextInput value={q} onValue={setQ} placeholder="Search notes — people, projects, decisions…" aria-label="Search memory" autoFocus={desktop} />
        </div>
        <form
          style={{ flex: '1 1 280px', display: 'flex', gap: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!capture.trim()) return;
            try {
              await post('/api/memory/save', { target: 'Inbox.md', content: `- ${capture.trim()}`, reason: 'Quick capture' });
              setCapture('');
              toast('Added to Inbox.md', { kind: 'success' });
            } catch (err) {
              toastError(err);
            }
          }}
        >
          <div style={{ flex: 1 }}>
            <TextInput value={capture} onValue={setCapture} placeholder="Jot something into Inbox.md" aria-label="Add to Inbox" />
          </div>
          <button className="btn" type="submit" disabled={!capture.trim()}>
            Add
          </button>
        </form>
      </div>
      <div className={desktop ? 'split' : ''}>
        <div className="panel" style={{ minWidth: 0 }}>
          {hits.error ? <div className="panel-body"><ErrorBox error={hits.error} /></div> : null}
          {list}
        </div>
        {desktop ? (
          <div className="panel detail-pane">
            <div className="panel-body" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
              {selected ? (
                <NoteView path={selected} caps={overview?.caps} onOpen={open} />
              ) : (
                <Empty title="Pick a note to read it">This is exactly what agents see when they call read_note. CORE.md and the task’s project note are preloaded; everything else is fetched on demand.</Empty>
              )}
            </div>
          </div>
        ) : selected ? (
          <Sheet title={selected.split('/').pop()!.replace(/\.md$/, '')} onClose={() => setQuery({ note: null })}>
            <NoteView path={selected} caps={overview?.caps} onOpen={open} />
          </Sheet>
        ) : null}
      </div>
    </>
  );
}

function ProposalsTab() {
  const pending = useApi<{ proposals: Proposal[] }>('/api/memory/proposals?status=pending', ['memory.proposal']);
  const history = useApi<{ proposals: Proposal[] }>('/api/memory/proposals', ['memory.proposal']);
  const [busy, setBusy] = useState(false);
  const decide = async (ids: string[], decision: 'approved' | 'rejected') => {
    setBusy(true);
    try {
      const r = await post<{ results: Array<{ status?: string; error?: string }> }>('/api/memory/proposals/batch', { ids, decision });
      const failed = r.results.filter((x) => x.status === 'failed' || x.error);
      if (failed.length) toast(`${failed.length} could not be applied — the note changed since. Ask the agent again.`, { kind: 'error' });
      else toast(decision === 'approved' ? `Applied ${ids.length} change${ids.length > 1 ? 's' : ''} (previous versions backed up)` : 'Rejected', { kind: 'success' });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const list = pending.data?.proposals ?? [];
  const done = (history.data?.proposals ?? []).filter((p) => p.status !== 'pending').slice(0, 30);
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Waiting for you</h2>
          <span className="count">{list.length}</span>
          {list.length > 1 ? (
            <div className="right">
              <button className="btn sm ghost" disabled={busy} onClick={() => void decide(list.map((p) => p.id), 'rejected')}>
                Reject all
              </button>
              <button className="btn sm primary" disabled={busy} onClick={() => void decide(list.map((p) => p.id), 'approved')}>
                Approve all {list.length}
              </button>
            </div>
          ) : null}
        </div>
        {pending.loading ? <SkeletonRows rows={2} /> : null}
        {!pending.loading && !list.length ? (
          <Empty title="No memory changes to review">Agents propose edits with save_memory. Daily-log, Inbox and Research appends apply on their own; CORE, Projects, People and Areas wait here.</Empty>
        ) : null}
        {list.map((p) => (
          <div className="approval" key={p.id}>
            <div className="approval-meta">
              <span className="chip warn">{p.mode === 'replace' ? 'Rewrite' : 'Append'}</span>
              <Link to={`/memory?note=${encodeURIComponent(p.target_path)}`} className="mono">
                {p.target_path}
              </Link>
              <span className="mono">{relTime(p.created_at)}</span>
              {p.run_id ? (
                <Link to={`/runs/${p.run_id}`} className="faint">
                  from run →
                </Link>
              ) : null}
            </div>
            {p.reason ? <div className="approval-what">{p.reason}</div> : null}
            <Diff text={p.diff} />
            <div className="approval-actions">
              <span style={{ flex: 1 }} />
              <button className="btn ghost" disabled={busy} onClick={() => void decide([p.id], 'rejected')}>
                Reject
              </button>
              <button className="btn primary" disabled={busy} onClick={() => void decide([p.id], 'approved')}>
                Approve
              </button>
            </div>
          </div>
        ))}
      </section>
      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2>Recent changes</h2>
        </div>
        {!done.length ? (
          <Empty title="No changes yet">Applied, rejected and failed proposals are listed here.</Empty>
        ) : (
          <ul className="list">
            {done.map((p) => (
              <li key={p.id}>
                <Link to={`/memory?note=${encodeURIComponent(p.target_path)}`} className="row">
                  <span className={`status ${p.status === 'applied' ? 'done' : p.status === 'failed' ? 'failed' : 'cancelled'}`}>
                    <span className="dot" />
                    {p.status}
                  </span>
                  <div className="row-stack">
                    <span className="title mono" style={{ fontSize: 12 }}>
                      {p.target_path}
                    </span>
                    <span className="sub">{p.error ?? p.reason}</span>
                  </div>
                  <span className="time">{relTime(p.created_at)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function HealthTab({ overview }: { overview: Overview | null }) {
  const mig = useApi<{ items: MigrationItem[] }>('/api/memory/migration', ['memory.updated']);
  const items = mig.data?.items ?? [];
  const checklist = items.map((i) => `- [ ] ${i.action} ${i.from ? `"${i.from}" → ` : ''}"${i.to}" — ${i.reason}`).join('\n');
  const corePct = overview?.coreTokens && overview.caps ? Math.min(100, (overview.coreTokens / overview.caps.core) * 100) : 0;
  return (
    <>
      <div className="grid-3">
        <div className="panel panel-body stat">
          <span className="label">Notes indexed</span>
          <span className="value">{overview ? overview.notes : '—'}</span>
          <span className="faint" style={{ fontSize: 12 }}>{overview ? (overview.fts ? 'SQLite FTS5 search' : 'LIKE fallback (FTS5 unavailable)') : ''}</span>
        </div>
        <div className="panel panel-body stat">
          <span className="label">CORE.md</span>
          <span className="value">{overview?.coreTokens != null ? `${tokens(overview.coreTokens)} / ${tokens(overview.caps.core)}` : '—'}</span>
          <div className={`bar ${corePct >= 100 ? 'hot' : corePct >= 85 ? 'warn' : ''}`} style={{ marginTop: 6 }}>
            <span style={{ width: `${corePct}%`, background: corePct < 85 ? 'var(--accent)' : undefined }} />
          </div>
        </div>
        <div className="panel panel-body stat">
          <span className="label">Context budget per run</span>
          <span className="value">{overview ? tokens(overview.caps.context) : '—'}</span>
          <Link to="/settings" className="faint" style={{ fontSize: 12 }}>
            Change in Settings →
          </Link>
        </div>
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2>Over size caps</h2>
          <span className="count">{overview?.sizes.length ?? ''}</span>
        </div>
        {!overview ? (
          <SkeletonRows rows={1} />
        ) : !overview.sizes.length ? (
          <Empty title="Everything is within its cap">CORE.md stays under {tokens(overview.caps.core)} tokens and each project note under {tokens(overview.caps.project)}.</Empty>
        ) : (
          <ul className="list">
            {overview.sizes.map((s) => (
              <li key={s.path}>
                <Link to={`/memory?note=${encodeURIComponent(s.path)}`} className="row">
                  <AlertTriangle size={14} strokeWidth={1.5} color="var(--danger)" />
                  <span className="title">{s.path}</span>
                  <span className="mono" style={{ color: 'var(--danger)', fontSize: 12 }}>
                    {tokens(s.tokens)} / {tokens(s.cap)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2>Migration proposal</h2>
          <span className="count">{items.length}</span>
          {items.length ? (
            <div className="right">
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(checklist);
                    toast('Checklist copied — paste it into a note', { kind: 'success' });
                  } catch {
                    toast('Clipboard is blocked in this browser.', { kind: 'error' });
                  }
                }}
              >
                <ClipboardCopy size={14} strokeWidth={1.5} /> Copy checklist
              </button>
            </div>
          ) : null}
        </div>
        <p className="faint" style={{ fontSize: 12, padding: '12px 16px 0' }}>
          Suggestions toward the standard layout (CORE, Areas, Projects, People, Skills, Research, Journal). Jarvis never moves files — do it in Obsidian so links update.
        </p>
        {mig.loading ? <SkeletonRows rows={3} /> : null}
        {!mig.loading && !items.length ? <Empty title="Your vault already matches the layout" /> : null}
        <ul className="list" style={{ marginTop: 8 }}>
          {items.map((i, idx) => (
            <li key={idx} className="row" style={{ alignItems: 'flex-start' }}>
              <span className={`chip ${i.action === 'trim' ? 'danger' : i.action === 'create' ? 'ok' : ''}`} style={{ marginTop: 2 }}>
                {i.action}
              </span>
              <div className="row-stack">
                <span className="mono" style={{ fontSize: 12, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
                  {i.from ? `${i.from} → ` : ''}
                  {i.to}
                </span>
                <span className="sub" style={{ whiteSpace: 'normal' }}>
                  {i.reason}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default function Memory() {
  const { query } = useLocation();
  const tab = (query.get('tab') as 'search' | 'proposals' | 'health') ?? 'search';
  const overview = useApi<Overview>('/api/memory/overview', ['memory.updated', 'memory.proposal']);
  const [reindexing, setReindexing] = useState(false);
  const o = overview.data;
  return (
    <div className="page wide">
      <PageHead
        title="Memory"
        sub={
          o ? (
            <span className="mono" style={{ fontSize: 12 }} title={o.vault}>
              {o.notes} notes{o.demoCopy ? ' · demo copy of fixtures/vault' : ''}
            </span>
          ) : undefined
        }
      >
        <Segmented
          label="Section"
          value={tab}
          onChange={(v) => navigate(v === 'search' ? '/memory' : `/memory?tab=${v}`)}
          options={[
            { value: 'search', label: 'Notes' },
            { value: 'proposals', label: `Proposals${o?.pending ? ` ${o.pending}` : ''}` },
            { value: 'health', label: `Health${o?.sizes.length ? ` ${o.sizes.length}` : ''}` },
          ]}
        />
        <button
          className="btn ghost icon"
          aria-label="Reindex vault"
          title="Reindex vault"
          disabled={reindexing}
          onClick={async () => {
            setReindexing(true);
            try {
              const r = await api<{ changed: number }>('/api/memory/reindex', { method: 'POST', body: {} });
              toast(r.changed ? `Reindexed ${r.changed} changed note${r.changed > 1 ? 's' : ''}` : 'Index is up to date', { kind: 'success' });
            } catch (err) {
              toastError(err);
            } finally {
              setReindexing(false);
            }
          }}
        >
          <RefreshCw size={16} strokeWidth={1.5} className={reindexing ? 'spin' : undefined} />
        </button>
      </PageHead>
      {overview.error ? <ErrorBox error={overview.error} onRetry={overview.reload} /> : null}
      {o && o.sizes.length && tab === 'search' ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} strokeWidth={1.5} color="var(--warning)" />
          <div>
            {o.sizes.length} note{o.sizes.length > 1 ? 's are' : ' is'} over its size cap ({o.sizes.map((s) => s.path).join(', ')}).{' '}
            <Link to="/memory?tab=health" className="muted" >
              <span style={{ textDecoration: 'underline' }}>See health</span>
            </Link>
          </div>
        </div>
      ) : null}
      {tab === 'search' ? <SearchTab overview={o} /> : tab === 'proposals' ? <ProposalsTab /> : <HealthTab overview={o} />}
    </div>
  );
}
