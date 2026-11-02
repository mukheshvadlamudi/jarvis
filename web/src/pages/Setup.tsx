import { Check, Copy, Download, FolderSearch, MonitorSmartphone, RotateCw, Share2 } from 'lucide-react';
import { useState } from 'react';
import { Empty, ErrorBox, Link, PageHead, Skeleton, Spinner, TextInput } from '../components/ui.tsx';
import { post } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';
import { desktop } from '../lib/desktop.ts';
import { installed, useInstallPrompt } from '../lib/install.ts';
import { toast, toastError } from '../lib/toast.ts';

interface Check {
  id: string;
  title: string;
  state: 'ok' | 'todo' | 'warn' | 'optional';
  detail: string;
  required: boolean;
  fix?: string[];
  action?: string;
}
interface SetupResponse {
  checks: Check[];
  progress: { done: number; total: number };
  complete: boolean;
  runner: 'mock' | 'real';
  platform: string;
  pendingRestart: boolean;
  launcher: boolean;
  suggestions: { vaults: string[]; codeRoots: string[] };
}

function Cmd({ text }: { text: string }) {
  if (text.startsWith('(')) return <p className="faint" style={{ fontSize: 12, marginTop: 4 }}>{text.slice(1, -1)}</p>;
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="btn sm ghost icon"
        aria-label={`Copy ${text}`}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            toast('Copied — paste it in a terminal opened in the Jarvis folder', { kind: 'success' });
          } catch {
            toast('Clipboard blocked — select the command and copy it.', { kind: 'error' });
          }
        }}
      >
        <Copy size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}

function VaultAction({ suggestions, onSaved }: { suggestions: string[]; onSaved: () => void }) {
  const [path, setPath] = useState('');
  const [check, setCheck] = useState<{ ok: boolean; notes: number; obsidian: boolean; path: string; error?: string } | null>(null);
  const test = async (save: boolean) => {
    try {
      const r = await post<{ ok: boolean; notes: number; obsidian: boolean; path: string; error?: string }>('/api/setup/vault', { path, save });
      setCheck(r);
      if (save) {
        toast('Vault saved — restart Jarvis to load it', { kind: 'success' });
        onSaved();
      }
    } catch (err) {
      setCheck({ ok: false, notes: 0, obsidian: false, path, error: (err as Error).message });
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <TextInput value={path} onValue={(v) => { setPath(v); setCheck(null); }} mic={false} className="mono" placeholder={'C:\\Users\\you\\Documents\\AI-System'} aria-label="Vault folder" />
        </div>
        <button className="btn" disabled={!path.trim()} onClick={() => void test(false)}>
          Check
        </button>
        <button className="btn primary" disabled={!check?.ok} onClick={() => void test(true)}>
          Use this vault
        </button>
      </div>
      {suggestions.length ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span className="faint" style={{ fontSize: 12 }}>Found on this computer:</span>
          {suggestions.map((s) => (
            <button key={s} className="chip" style={{ cursor: 'pointer', background: 'transparent' }} onClick={() => { setPath(s); setCheck(null); }}>
              {s}
            </button>
          ))}
        </div>
      ) : null}
      {check ? (
        <p style={{ fontSize: 12, color: check.ok ? 'var(--success)' : 'var(--danger)' }}>
          {check.ok ? `${check.notes} notes${check.obsidian ? ' · Obsidian vault' : ' · no .obsidian folder (fine if you use another editor)'} — Jarvis only writes through reviewed proposals.` : check.error}
        </p>
      ) : null}
    </div>
  );
}

function ProjectsAction({ roots, onAdded }: { roots: string[]; onAdded: () => void }) {
  const [path, setPath] = useState(roots[0] ?? '');
  const [repos, setRepos] = useState<Array<{ name: string; path: string; registered: boolean }> | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const scan = async () => {
    setBusy(true);
    try {
      const r = await post<{ repos: Array<{ name: string; path: string; registered: boolean }> }>('/api/setup/scan', { path });
      setRepos(r.repos);
      setPicked(new Set(r.repos.filter((x) => !x.registered).map((x) => x.path)));
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  const connect = async () => {
    try {
      const chosen = (repos ?? []).filter((r) => picked.has(r.path));
      const r = await post<{ added: number }>('/api/setup/projects', { repos: chosen });
      toast(`Connected ${r.added} repo${r.added === 1 ? '' : 's'}`, { kind: 'success' });
      setRepos(null);
      onAdded();
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <TextInput value={path} onValue={setPath} mic={false} className="mono" placeholder={'C:\\Users\\you\\code'} aria-label="Folder with repositories" />
        </div>
        <button className="btn" disabled={!path.trim() || busy} onClick={() => void scan()}>
          {busy ? <Spinner /> : <FolderSearch size={14} strokeWidth={1.5} />} Find repos
        </button>
      </div>
      {roots.length > 1 ? (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {roots.map((r) => (
            <button key={r} className="chip" style={{ cursor: 'pointer', background: 'transparent' }} onClick={() => setPath(r)}>
              {r}
            </button>
          ))}
        </div>
      ) : null}
      {repos ? (
        repos.length ? (
          <div className="panel">
            <ul className="list">
              {repos.map((r) => (
                <li key={r.path} className="row">
                  <input
                    type="checkbox"
                    aria-label={`Connect ${r.name}`}
                    checked={r.registered || picked.has(r.path)}
                    disabled={r.registered}
                    onChange={(e) => {
                      const n = new Set(picked);
                      if (e.target.checked) n.add(r.path);
                      else n.delete(r.path);
                      setPicked(n);
                    }}
                    style={{ accentColor: 'var(--accent)', width: 16, height: 16 }}
                  />
                  <div className="row-stack">
                    <span className="title">{r.name}</span>
                    <span className="sub mono" style={{ fontSize: 11 }}>{r.path}</span>
                  </div>
                  {r.registered ? <span className="chip ok">connected</span> : null}
                </li>
              ))}
            </ul>
            <div style={{ padding: 12, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn primary" disabled={!picked.size} onClick={() => void connect()}>
                Connect {picked.size} repo{picked.size === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        ) : (
          <p className="faint" style={{ fontSize: 12 }}>No git repositories within two levels of that folder.</p>
        )
      ) : null}
    </div>
  );
}

function TelegramAction({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState('');
  const [chat, setChat] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
      <p className="faint" style={{ fontSize: 12 }}>
        1. Message @BotFather → /newbot, copy the token. 2. Message @userinfobot to get your chat id. Only that chat can talk to Jarvis.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input className="input mono" style={{ flex: '2 1 220px' }} type="password" placeholder="Bot token" aria-label="Telegram bot token" value={token} onChange={(e) => setToken(e.target.value)} />
        <input className="input mono" style={{ flex: '1 1 120px' }} inputMode="numeric" placeholder="Chat id" aria-label="Telegram chat id" value={chat} onChange={(e) => setChat(e.target.value)} />
        <button
          className="btn"
          disabled={!token || !chat}
          onClick={async () => {
            try {
              await post('/api/setup/telegram', { token, chatId: chat });
              toast('Saved — restart Jarvis to connect the bot', { kind: 'success' });
              onSaved();
            } catch (err) {
              toastError(err);
            }
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

function VerifyAction({ agent, mock, onDone }: { agent: 'claude' | 'codex'; mock: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <button
        className="btn"
        disabled={busy || mock}
        title={mock ? 'Mock mode never calls real agents' : undefined}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await post<{ ok: boolean; reply: string }>(`/api/setup/verify/${agent}`);
            toast(`${agent === 'claude' ? 'Claude' : 'Codex'} answered “${r.reply}” — login works`, { kind: 'success' });
            onDone();
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner /> : <Check size={14} strokeWidth={1.5} />} Verify with one tiny run
      </button>
      <span className="faint" style={{ fontSize: 12 }}>{mock ? 'Available when JARVIS_RUNNER=real.' : 'Uses a few hundred tokens of your plan.'}</span>
    </div>
  );
}

export default function Setup() {
  const res = useApi<SetupResponse>('/api/setup', ['project.*', 'skills.updated', 'schedule.updated']);
  const { available, install } = useInstallPrompt();
  const [restarting, setRestarting] = useState(false);
  const d = res.data;
  const pct = d ? (d.progress.done / d.progress.total) * 100 : 0;

  const restart = async () => {
    setRestarting(true);
    try {
      await post('/api/setup/restart');
      toast('Restarting…');
      const until = Date.now() + 60_000;
      const poll = async () => {
        try {
          const r = await fetch('/api/health');
          if (r.ok) {
            location.reload();
            return;
          }
        } catch {
          // still down
        }
        if (Date.now() < until) window.setTimeout(poll, 1000);
        else setRestarting(false);
      };
      window.setTimeout(poll, 2500);
    } catch (err) {
      toastError(err);
      setRestarting(false);
    }
  };

  return (
    <div className="page">
      <PageHead title="Set up Jarvis" sub={d ? `${d.progress.done} of ${d.progress.total} required steps done` : undefined} />
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
      {d ? (
        <div className="progress" style={{ marginBottom: 24 }} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Setup progress">
          <span style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      {d?.pendingRestart ? (
        <div className="setup-banner">
          <RotateCw size={16} strokeWidth={1.5} color="var(--accent)" />
          <span style={{ flex: 1 }}>New settings are saved. Restart Jarvis to load them.</span>
          {d.launcher ? (
            <button className="btn primary sm" disabled={restarting} onClick={() => void restart()}>
              {restarting ? <Spinner /> : null} Restart now
            </button>
          ) : (
            <span className="faint" style={{ fontSize: 12 }}>Stop it (Ctrl+C) and start it again.</span>
          )}
        </div>
      ) : null}
      {d?.runner === 'mock' ? (
        <div className="notice" style={{ marginBottom: 16 }}>
          <span>
            Demo mode: agents are simulated and nothing uses your plans. Set <code>JARVIS_RUNNER=real</code> in <code>.env</code> when you’re ready.
          </span>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-head">
          <h2>Checklist</h2>
        </div>
        {!d ? (
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <Skeleton w="60%" />
            <Skeleton w="80%" />
            <Skeleton w="50%" />
          </div>
        ) : (
          <ol className="steps">
            {d.checks.map((c, i) => (
              <li key={c.id} className="step" data-state={c.state}>
                <span className="step-mark" aria-label={c.state === 'ok' ? 'done' : c.state === 'warn' ? 'needs attention' : c.required ? 'to do' : 'optional'}>
                  {c.state === 'ok' ? <Check size={14} strokeWidth={2} /> : c.state === 'warn' ? '!' : i + 1}
                </span>
                <div style={{ minWidth: 0 }}>
                  <h3>
                    {c.title} {!c.required ? <span className="faint" style={{ fontWeight: 400, fontSize: 12 }}>· optional</span> : null}
                  </h3>
                  <p>{c.detail}</p>
                  {c.state !== 'ok' && desktop && (c.id === 'claude' || c.id === 'codex') ? (
                    <button
                      className="btn primary sm"
                      style={{ marginTop: 10 }}
                      onClick={async () => {
                        const r = await desktop!.login(c.id as 'claude' | 'codex');
                        toast(r.message, { kind: r.ok ? 'info' : 'error', ms: 9000 });
                      }}
                    >
                      Log in to {c.id === 'claude' ? 'Claude' : 'Codex'}
                    </button>
                  ) : c.state !== 'ok' && c.fix ? (
                    c.fix.map((f) => <Cmd key={f} text={f} />)
                  ) : null}
                  {c.action === 'verify-claude' && c.state !== 'ok' ? <VerifyAction agent="claude" mock={d.runner === 'mock'} onDone={res.reload} /> : null}
                  {c.action === 'verify-codex' && c.state !== 'ok' ? <VerifyAction agent="codex" mock={d.runner === 'mock'} onDone={res.reload} /> : null}
                  {c.action === 'vault' && c.state !== 'ok' ? <VaultAction suggestions={d.suggestions.vaults} onSaved={res.reload} /> : null}
                  {c.action === 'projects' ? <ProjectsAction roots={d.suggestions.codeRoots} onAdded={res.reload} /> : null}
                  {c.action === 'telegram' && c.state !== 'ok' ? <TelegramAction onSaved={res.reload} /> : null}
                  {c.action === 'skills' && c.state !== 'ok' ? (
                    <Link to="/skills" className="btn sm" style={{ marginTop: 10 }}>
                      Open Skills
                    </Link>
                  ) : null}
                  {c.action === 'routines' && c.state !== 'ok' ? (
                    <Link to="/schedules" className="btn sm" style={{ marginTop: 10 }}>
                      Open Schedules
                    </Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <div className="grid-2" style={{ marginTop: 24 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>{desktop ? 'Desktop app' : 'Install as an app'}</h2>
          </div>
          <div className="panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 13 }}>
            {desktop ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <p className="muted">You are in the Jarvis desktop app. Closing the window keeps Jarvis running in the tray so routines still fire; quit from the tray icon. Ctrl+Shift+J captures a task from anywhere.</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn sm" onClick={() => void desktop!.openPath('data')}>Open data folder</button>
                  <button className="btn sm ghost" onClick={() => void desktop!.openPath('logs')}>Open logs</button>
                </div>
              </div>
            ) : installed() ? (
              <Empty title="Running as an installed app." />
            ) : (
              <>
                <p className="muted">Lightest option: install Jarvis from the browser as an app — its own window, taskbar/dock icon and Start-menu entry. (There is also a full desktop app with tray and notifications; see Releases.)</p>
                {available ? (
                  <button className="btn primary" style={{ alignSelf: 'flex-start' }} onClick={() => void install().then((ok) => ok && toast('Installed — find Jarvis in your Start menu or dock', { kind: 'success' }))}>
                    <Download size={14} strokeWidth={1.5} /> Install Jarvis
                  </button>
                ) : (
                  <p className="faint">
                    In Chrome or Edge use the install icon in the address bar (or menu → “Install Jarvis”). On iPhone: Share → Add to Home Screen. On Android: menu → Install app.
                  </p>
                )}
                <p className="faint" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <MonitorSmartphone size={14} strokeWidth={1.5} /> Phone access goes over Tailscale with an access token (JARVIS_BIND + JARVIS_ACCESS_TOKEN).
                </p>
              </>
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>Give Jarvis to someone</h2>
          </div>
          <div className="panel-body" style={{ fontSize: 13 }}>
            <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }} className="muted">
              <li>
                Easiest: send them the <strong>desktop installer</strong> (<code>Jarvis-Setup.exe</code>, <code>.dmg</code> or <code>.AppImage</code> from the project’s Releases). Nothing else to install except Git.
              </li>
              <li>They open Jarvis, press “Log in to Claude / Codex” here with <em>their own</em> plans, and pick their vault and code folders.</li>
              <li>
                Or from source: install Node.js 24, download the folder, double-click <code>start-jarvis.cmd</code> / <code>.command</code> / <code>.sh</code>.
              </li>
            </ol>
            <p className="faint" style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Share2 size={14} strokeWidth={1.5} /> Each person uses their own logins, vault and data — nothing is shared.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
