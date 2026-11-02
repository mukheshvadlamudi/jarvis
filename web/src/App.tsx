import { MoreHorizontal, Plus } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import { CaptureSheet } from './components/CommandBar.tsx';
import { Palette } from './components/Palette.tsx';
import { Link, Skeleton, Toasts } from './components/ui.tsx';
import { api, getToken, onUnauthorized, setToken } from './lib/api.ts';
import { useApi } from './lib/hooks.ts';
import { connectLive, disconnectLive, useLiveState } from './lib/live.ts';
import { match, navigate, useLocation } from './lib/router.ts';
import { toggleTheme } from './lib/theme.ts';
import { desktop } from './lib/desktop.ts';
import { VoiceDock, VoiceToggle } from './components/VoiceDock.tsx';
import { startVoiceController } from './voice/controller.ts';
import { routes } from './routes.ts';
import type { PageProps, RouteDef } from './routes.ts';

const lazyCache = new Map<string, LazyExoticComponent<ComponentType<PageProps>>>();
function pageFor(r: RouteDef) {
  let c = lazyCache.get(r.path);
  if (!c) {
    c = lazy(r.load);
    lazyCache.set(r.path, c);
  }
  return c;
}

interface Summary {
  counts: Record<string, number>;
  approvals: number;
  active: Array<{ taskId: string; runId: string; agent: string }>;
}

const NAV_GROUPS: Array<{ key: NonNullable<RouteDef['nav']>; label: string | null }> = [
  { key: 'main', label: null },
  { key: 'work', label: 'Workspaces' },
  { key: 'knowledge', label: 'Knowledge' },
  { key: 'system', label: 'System' },
];

function Mark() {
  return (
    <svg className="brand-mark" viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="29" fill="none" stroke="var(--border-strong)" strokeWidth="2" />
      <circle cx="32" cy="32" r="21" fill="none" stroke="var(--text-muted)" strokeWidth="3" strokeDasharray="10 4.3" />
      <circle cx="32" cy="32" r="9" fill="var(--accent)" />
    </svg>
  );
}

function PageFallback() {
  return (
    <div className="page" aria-busy="true">
      <div className="page-head">
        <Skeleton w={140} h={20} />
      </div>
      <div className="panel">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="row" key={i}>
            <Skeleton w={8} h={8} />
            <Skeleton w={`${50 + ((i * 13) % 40)}%`} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="signin">
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          setToken(value.trim());
          try {
            await api('/api/summary');
            onDone();
          } catch {
            setToken(null);
            setError('That token was not accepted. It must match JARVIS_ACCESS_TOKEN in the server’s .env.');
          }
        }}
      >
        <div className="panel-head">
          <Mark />
          <h2>Jarvis</h2>
        </div>
        <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p className="muted" style={{ fontSize: 13 }}>
            Remote access is on, so this Jarvis needs its access token.
          </p>
          <div className="field">
            <label htmlFor="token">Access token</label>
            <input id="token" className="input mono" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          </div>
          {error ? <p style={{ color: 'var(--danger)', fontSize: 13 }}>{error}</p> : null}
          <button className="btn primary" type="submit" disabled={!value.trim()}>
            Unlock
          </button>
        </div>
      </form>
    </div>
  );
}

export function App() {
  const { path } = useLocation();
  const [locked, setLocked] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const live = useLiveState();
  const summary = useApi<Summary>(locked ? null : '/api/summary', ['task.*', 'approval.*', 'run.started', 'run.finished', 'hello']);

  useEffect(() => onUnauthorized(() => setLocked(true)), []);
  useEffect(() => (locked ? undefined : startVoiceController()), [locked]);
  useEffect(() => {
    if (!desktop) return;
    document.documentElement.classList.add('desktop', `desktop-${desktop.platform}`);
    return desktop.onCapture(() => setCaptureOpen(true));
  }, []);
  useEffect(() => {
    if (locked) {
      disconnectLive();
      return;
    }
    connectLive();
  }, [locked]);

  const current = useMemo(() => {
    for (const r of routes) {
      const params = match(r.path, path);
      if (params) return { route: r, params };
    }
    return null;
  }, [path]);

  useEffect(() => {
    document.title = current ? (current.route.path === '/' ? 'Jarvis' : `${current.route.title} · Jarvis`) : 'Jarvis';
  }, [current]);

  // Global shortcuts: Ctrl/Cmd+K palette, c capture, / search, g <key> go to.
  useEffect(() => {
    let pendingG = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || paletteOpen || captureOpen) return;
      if (e.key === '/') {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (e.key === 'c') {
        e.preventDefault();
        setCaptureOpen(true);
        return;
      }
      if (e.key === 'g') {
        pendingG = Date.now();
        return;
      }
      if (Date.now() - pendingG < 1200) {
        const r = routes.find((x) => x.key === e.key);
        pendingG = 0;
        if (r) {
          e.preventDefault();
          navigate(r.path);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [paletteOpen, captureOpen]);

  if (locked || (getToken() === null && summary.error && 'status' in summary.error && (summary.error as { status: number }).status === 401)) {
    return (
      <SignIn
        onDone={() => {
          setLocked(false);
          summary.reload();
        }}
      />
    );
  }

  const counts = summary.data?.counts ?? {};
  const badgeFor = (r: RouteDef) => (r.badge === 'approvals' ? summary.data?.approvals ?? 0 : r.badge === 'needs_you' ? counts.needs_you ?? 0 : 0);
  const navRoutes = routes.filter((r) => r.nav).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  const isActive = (r: RouteDef) => (r.path === '/' ? path === '/' || path.startsWith('/c/') : path === r.path || path.startsWith(`${r.path}/`));
  const Page = current ? pageFor(current.route) : null;
  const running = summary.data?.active.length ?? 0;

  return (
    <div className="shell">
      {desktop ? <div className="titlebar" aria-hidden /> : null}
      <a href="#main" className="sr-only" onFocus={(e) => e.currentTarget.classList.remove('sr-only')} onBlur={(e) => e.currentTarget.classList.add('sr-only')}>
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Primary">
        <div className="brand">
          <Mark />
          <span>Jarvis</span>
          <span className="brand-status" title={live === 'open' ? 'Live updates connected' : 'Reconnecting to live updates'}>
            <span className={`dot${running ? ' live' : ''}`} style={{ color: live === 'open' ? (running ? 'var(--accent)' : 'var(--success)') : 'var(--warning)' }} />
            {running ? `${running} running` : live === 'open' ? 'idle' : 'offline'}
          </span>
        </div>
        <button className="search-trigger" onClick={() => setPaletteOpen(true)}>
          <span>Search or command</span>
          <kbd>{navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {NAV_GROUPS.map((g) => {
          const items = navRoutes.filter((r) => r.nav === g.key);
          if (!items.length) return null;
          return (
            <div key={g.key}>
              {g.label ? <div className="nav-section">{g.label}</div> : null}
              {items.map((r) => {
                const Icon = r.icon;
                const n = badgeFor(r);
                return (
                  <Link key={r.path} to={r.path} className="nav-link" aria-current={isActive(r) ? 'page' : undefined}>
                    <Icon size={16} strokeWidth={1.5} />
                    {r.title}
                    {n ? <span className={`nav-count${r.badge ? ' hot' : ''}`}>{n}</span> : null}
                  </Link>
                );
              })}
            </div>
          );
        })}
        <div className="sidebar-foot">
          <button className="btn primary" onClick={() => setCaptureOpen(true)}>
            <Plus size={16} strokeWidth={1.5} /> New task <kbd style={{ marginLeft: 4, background: 'transparent', borderColor: 'rgba(0,0,0,.25)', color: 'inherit' }}>C</kbd>
          </button>
          <div style={{ display: 'flex', gap: 6 }}>
            <VoiceToggle compact />
            <button className="btn ghost sm" onClick={toggleTheme} style={{ flex: 1 }}>
              Theme
            </button>
          </div>
        </div>
      </nav>

      <main className="main" id="main">
        <Suspense fallback={<PageFallback />}>
          {path === '/more' ? (
            <MorePage badgeFor={badgeFor} />
          ) : Page && current ? (
            <Page params={current.params} />
          ) : (
            <div className="page">
              <div className="empty center">
                <strong>Nothing lives at {path}</strong>
                <span>The link may be from an older version of Jarvis.</span>
                <Link to="/" className="btn">
                  Go home
                </Link>
              </div>
            </div>
          )}
        </Suspense>
      </main>

      <nav className="tabbar" aria-label="Primary">
        {routes
          .filter((r) => ['/', '/board'].includes(r.path))
          .map((r) => {
            const Icon = r.icon;
            const n = badgeFor(r);
            return (
              <Link key={r.path} to={r.path} className="tab" aria-current={isActive(r) ? 'page' : undefined}>
                <Icon size={20} strokeWidth={1.5} />
                {r.title}
                {n ? <span className="tab-badge">{n}</span> : null}
              </Link>
            );
          })}
        <button className="tab" aria-label="New task" onClick={() => setCaptureOpen(true)}>
          <span className="tab-capture">
            <Plus size={20} strokeWidth={2} />
          </span>
        </button>
        {routes
          .filter((r) => r.path === '/approvals')
          .map((r) => {
            const Icon = r.icon;
            const n = badgeFor(r);
            return (
              <Link key={r.path} to={r.path} className="tab" aria-current={isActive(r) ? 'page' : undefined}>
                <Icon size={20} strokeWidth={1.5} />
                {r.title}
                {n ? <span className="tab-badge">{n}</span> : null}
              </Link>
            );
          })}
        <Link to="/more" className="tab" aria-current={path === '/more' ? 'page' : undefined}>
          <MoreHorizontal size={20} strokeWidth={1.5} />
          More
        </Link>
      </nav>

      {paletteOpen ? <Palette onClose={() => setPaletteOpen(false)} onCapture={() => setCaptureOpen(true)} /> : null}
      {captureOpen ? <CaptureSheet onClose={() => setCaptureOpen(false)} /> : null}
      <VoiceDock />
      <Toasts />
    </div>
  );
}

function MorePage({ badgeFor }: { badgeFor: (r: RouteDef) => number }) {
  const items = routes.filter((r) => r.nav && !['/', '/board', '/approvals'].includes(r.path)).sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return (
    <div className="page">
      <header className="page-head">
        <h1>More</h1>
        <div className="actions">
          <VoiceToggle compact />
          <button className="btn ghost sm" onClick={toggleTheme}>
            Toggle theme
          </button>
        </div>
      </header>
      <div className="panel">
        {items.map((r) => {
          const Icon = r.icon;
          const n = badgeFor(r);
          return (
            <Link key={r.path} to={r.path} className="row">
              <Icon size={18} strokeWidth={1.5} color="var(--text-muted)" />
              <span className="title">{r.title}</span>
              {n ? <span className="nav-count hot">{n}</span> : null}
            </Link>
          );
        })}
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 16 }}>
        Tip: on a keyboard, press <kbd>Ctrl</kbd> <kbd>K</kbd> to search, <kbd>C</kbd> to capture a task.
      </p>
    </div>
  );
}
