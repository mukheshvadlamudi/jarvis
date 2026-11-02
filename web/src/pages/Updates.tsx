import { CheckCheck, ExternalLink, Plus, RefreshCw, Rss, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorBox, PageHead, Segmented, Sheet, SkeletonRows, Switch, TextInput } from '../components/ui.tsx';
import { del, patch, post } from '../lib/api.ts';
import { relTime } from '../lib/format.ts';
import { useApi, useNow } from '../lib/hooks.ts';
import { setQuery, useLocation } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';

interface Source {
  id: string;
  name: string;
  url: string;
  kind: 'rss' | 'atom' | 'github' | 'page';
  enabled: number;
  last_checked_at: string | null;
  last_error: string | null;
  unseen: number;
  total: number;
}
interface Item {
  id: string;
  source_id: string;
  source: string;
  kind: string;
  title: string;
  url: string;
  published_at: string | null;
  summary: string;
  seen: number;
}

const KIND_LABEL: Record<Source['kind'], string> = { rss: 'RSS', atom: 'Atom', github: 'GitHub releases', page: 'Page (change detection)' };

function SourcesSheet({ sources, onClose, reload }: { sources: Source[]; onClose: () => void; reload: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Sheet title="Sources" onClose={onClose}>
      <form
        style={{ display: 'flex', gap: 8, marginBottom: 8 }}
        onSubmit={async (e) => {
          e.preventDefault();
          if (!url.trim()) return;
          setBusy(true);
          try {
            const r = await post<{ source: Source }>('/api/feeds', { url: url.trim() });
            toast(`Following ${r.source.name} (${KIND_LABEL[r.source.kind]})`, { kind: 'success' });
            setUrl('');
            reload();
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div style={{ flex: 1 }}>
          <TextInput value={url} onValue={setUrl} mic={false} placeholder="https://github.com/owner/repo/releases.atom" aria-label="Feed or page URL" />
        </div>
        <button className="btn primary" type="submit" disabled={busy || !url.trim()}>
          <Plus size={14} strokeWidth={1.5} /> Add
        </button>
      </form>
      <p className="faint" style={{ fontSize: 12, marginBottom: 16 }}>
        RSS, Atom and GitHub <code>releases.atom</code> feeds are parsed; any other page is watched for changes. Fetching is plain HTTP — no agent, no plan usage.
      </p>
      <div className="panel">
        {!sources.length ? <Empty title="No sources yet." /> : null}
        <ul className="list">
          {sources.map((s) => (
            <li key={s.id} className="row" style={{ flexWrap: 'wrap' }}>
              <Switch
                label={`${s.enabled ? 'Pause' : 'Resume'} ${s.name}`}
                checked={!!s.enabled}
                onChange={async (v) => {
                  try {
                    await patch(`/api/feeds/${s.id}`, { enabled: v });
                    reload();
                  } catch (err) {
                    toastError(err);
                  }
                }}
              />
              <div className="row-stack" style={{ flex: '1 1 200px' }}>
                <span className="title">{s.name}</span>
                <span className="sub mono" style={{ fontSize: 11 }}>{s.url}</span>
                <span className="sub" style={s.last_error ? { color: 'var(--danger)' } : undefined}>
                  {KIND_LABEL[s.kind]} · {s.last_error ? `last check failed: ${s.last_error}` : s.last_checked_at ? `checked ${relTime(s.last_checked_at)}` : 'not checked yet'}
                </span>
              </div>
              <button
                className="btn sm ghost icon"
                aria-label={`Remove ${s.name}`}
                onClick={async () => {
                  if (!confirm(`Stop following ${s.name}? Its items are removed too.`)) return;
                  try {
                    await del(`/api/feeds/${s.id}`);
                    reload();
                  } catch (err) {
                    toastError(err);
                  }
                }}
              >
                <Trash2 size={14} strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  );
}

export default function Updates() {
  const { query } = useLocation();
  const view = query.get('view') === 'all' ? 'all' : 'unseen';
  const source = query.get('source') ?? '';
  const sources = useApi<{ sources: Source[]; autoFetch: boolean; everyHours: number }>('/api/feeds', ['feed.updated']);
  const items = useApi<{ items: Item[] }>(`/api/feeds/items?limit=150${view === 'unseen' ? '&unseen=1' : ''}${source ? `&source=${source}` : ''}`, ['feed.updated']);
  const [manage, setManage] = useState(false);
  const [fetching, setFetching] = useState(false);
  const now = useNow();
  const list = items.data?.items ?? [];
  const unseen = (sources.data?.sources ?? []).reduce((n, s) => n + s.unseen, 0);

  const markSeen = async (ids: string[] | 'all') => {
    try {
      await post('/api/feeds/items/seen', ids === 'all' ? { all: true } : { ids });
      items.reload();
      sources.reload();
    } catch (err) {
      toastError(err);
    }
  };

  return (
    <div className="page">
      <PageHead title="Updates" sub={sources.data ? `${unseen} unseen · ${sources.data.autoFetch ? `checked every ${sources.data.everyHours} h` : 'auto-fetch off in mock mode'}` : undefined}>
        <Segmented
          label="Show"
          value={view}
          onChange={(v) => setQuery({ view: v === 'unseen' ? null : v })}
          options={[
            { value: 'unseen', label: 'Unseen' },
            { value: 'all', label: 'All' },
          ]}
        />
        <button
          className="btn ghost icon"
          aria-label="Check all feeds now"
          title="Check all feeds now"
          disabled={fetching}
          onClick={async () => {
            setFetching(true);
            try {
              const r = await post<{ added: number; errors: number }>('/api/feeds/fetch');
              toast(`${r.added} new item${r.added === 1 ? '' : 's'}${r.errors ? ` · ${r.errors} source${r.errors === 1 ? '' : 's'} failed` : ''}`, { kind: r.errors ? 'error' : 'success' });
              items.reload();
              sources.reload();
            } catch (err) {
              toastError(err);
            } finally {
              setFetching(false);
            }
          }}
        >
          <RefreshCw size={16} strokeWidth={1.5} className={fetching ? 'spin' : undefined} />
        </button>
        <button className="btn" onClick={() => setManage(true)}>
          <Rss size={14} strokeWidth={1.5} /> Sources
        </button>
      </PageHead>
      {items.error ? <ErrorBox error={items.error} onRetry={items.reload} /> : null}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
        <button className={`chip${!source ? ' accent' : ''}`} style={{ cursor: 'pointer', background: source ? 'transparent' : undefined }} onClick={() => setQuery({ source: null })}>
          All sources
        </button>
        {(sources.data?.sources ?? []).map((s) => (
          <button key={s.id} className={`chip${source === s.id ? ' accent' : ''}`} style={{ cursor: 'pointer', background: source === s.id ? undefined : 'transparent' }} onClick={() => setQuery({ source: s.id })}>
            {s.name}
            {s.unseen ? <span className="mono">{s.unseen}</span> : null}
          </button>
        ))}
      </div>

      <section className="panel">
        <div className="panel-head">
          <h2>{view === 'unseen' ? 'Unseen' : 'All items'}</h2>
          <span className="count">{list.length}</span>
          {view === 'unseen' && list.length ? (
            <div className="right">
              <button className="btn sm ghost" onClick={() => void markSeen(source ? list.map((i) => i.id) : 'all')}>
                <CheckCheck size={14} strokeWidth={1.5} /> Mark all seen
              </button>
            </div>
          ) : null}
        </div>
        {items.loading ? <SkeletonRows rows={5} /> : null}
        {!items.loading && !list.length ? (
          sources.data?.sources.length ? (
            <Empty title={view === 'unseen' ? 'You’re caught up.' : 'Nothing fetched yet.'}>The daily Updates digest summarises new items and marks them seen once it finishes.</Empty>
          ) : (
            <Empty title="Follow releases, blogs and changelogs." action={<button className="btn" onClick={() => setManage(true)}><Plus size={14} strokeWidth={1.5} /> Add a source</button>}>
              Add RSS/Atom feeds, GitHub releases.atom URLs, or any page to watch for changes.
            </Empty>
          )
        ) : null}
        <ul className="list">
          {list.map((i) => (
            <li key={i.id} className="row" style={{ alignItems: 'flex-start', opacity: i.seen ? 0.7 : 1 }}>
              <span className={`dot`} style={{ marginTop: 8, color: i.seen ? 'transparent' : 'var(--accent)' }} aria-label={i.seen ? 'seen' : 'unseen'} />
              <div className="row-stack">
                <a href={i.url} target="_blank" rel="noreferrer" className="title" style={{ whiteSpace: 'normal' }} onClick={() => !i.seen && void markSeen([i.id])}>
                  {i.title} <ExternalLink size={12} strokeWidth={1.5} style={{ verticalAlign: -1, color: 'var(--text-faint)' }} />
                </a>
                {i.summary ? <span className="sub" style={{ whiteSpace: 'normal' }}>{i.summary.length > 220 ? `${i.summary.slice(0, 217)}…` : i.summary}</span> : null}
                <span className="faint" style={{ fontSize: 12 }}>
                  {i.source} · {relTime(i.published_at, now)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </section>
      {manage ? (
        <SourcesSheet
          sources={sources.data?.sources ?? []}
          onClose={() => setManage(false)}
          reload={() => {
            sources.reload();
            items.reload();
          }}
        />
      ) : null}
    </div>
  );
}
