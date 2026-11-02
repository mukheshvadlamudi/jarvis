import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { PageProps } from '../routes.ts';
import { Empty, ErrorBox, PageHead, SkeletonRows } from '../components/ui.tsx';
import { api, post } from '../lib/api.ts';
import { useApi } from '../lib/hooks.ts';

type Agent = 'claude' | 'codex';
interface Connector {
  name: string; transport: string; target: string; status: string;
  tools: number | null; error: string | null; removable: boolean; scope: string | null;
}
interface Listing { claude: Connector[]; codex: Connector[]; errors: string[] }
interface Result { agent: Agent; ok: boolean; message: string }

function splitCommand(input: string): string[] {
  const words: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i]!;
    if (char === '\\' && input[i + 1] && (input[i + 1] === quote || input[i + 1] === '"' || input[i + 1] === "'")) {
      word += input[++i]; started = true;
    } else if (quote) {
      if (char === quote) quote = ''; else word += char;
    } else if (char === '"' || char === "'") {
      quote = char; started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = ''; started = false;
    } else { word += char; started = true; }
  }
  if (quote) throw new Error('Close the quote in the command field');
  if (started) words.push(word);
  return words;
}

export default function Connectors({ params: _params }: PageProps) {
  const res = useApi<Listing>('/api/connectors');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [agents, setAgents] = useState<Record<Agent, boolean>>({ claude: true, codex: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [results, setResults] = useState<Result[]>([]);

  const refresh = async () => {
    const data = await api<Listing>('/api/connectors?fresh=1');
    res.setData(() => data);
  };
  const add = async () => {
    setBusy('add'); setError(null); setResults([]);
    try {
      const selected = (['claude', 'codex'] as const).filter((a) => agents[a]);
      const pairs: Record<string, string> = {};
      if (transport === 'stdio') for (const line of env.split(/\r?\n/).filter((l) => l.trim())) {
        const eq = line.indexOf('=');
        if (eq < 1) throw new Error('Enter each env pair as KEY=VALUE');
        pairs[line.slice(0, eq).trim()] = line.slice(eq + 1);
      }
      const [bin, ...args] = transport === 'stdio' ? splitCommand(command) : [];
      const result = await post<{ results: Result[] }>('/api/connectors', { name, agents: selected, transport, ...(transport === 'stdio' ? { command: bin, args, env: pairs } : { url }) });
      setResults(result.results);
      setEnv('');
      await refresh();
    } catch (err) { setError(err as Error); }
    finally { setBusy(null); }
  };
  const remove = async (agent: Agent, connector: Connector) => {
    setBusy(`${agent}:${connector.name}`); setError(null); setResults([]);
    try {
      setResults([await api<Result>(`/api/connectors/${agent}/${encodeURIComponent(connector.name)}`, { method: 'DELETE' })]);
      setConfirm(null);
      await refresh();
    } catch (err) { setError(err as Error); }
    finally { setBusy(null); }
  };

  return <div className="page connectors-page">
    <style>{`
      .connectors-page { min-width: 0 }
      .connectors-page .panel { margin-bottom: 24px; min-width: 0 }
      .connectors-page .row { flex-wrap: wrap; gap: 12px }
      .connectors-page .row-stack { flex: 1 1 180px; min-width: 0 }
      .connectors-page .connector-target { overflow-wrap: anywhere; white-space: normal; font-size: 12px }
      .connectors-page .connector-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px }
      .connectors-page .connector-status { display: inline-flex; align-items: center; gap: 8px }
      .connectors-page .connector-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0 }
      .connectors-page .connector-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center }
      .connectors-page .connector-check { display: inline-flex; gap: 8px; align-items: center; min-height: 44px; cursor: pointer; margin-right: 16px }
      .connectors-page .connector-check input { appearance: none; width: 16px; height: 16px; border: 1px solid var(--border-strong); border-radius: 4px; background: var(--bg-sunken); cursor: pointer }
      .connectors-page .connector-check input:checked { background: var(--primary); border-color: var(--primary); box-shadow: inset 0 0 0 3px var(--bg-raised) }
      .connectors-page .field { min-width: 0 }
      .connectors-page .input, .connectors-page .textarea { width: 100%; min-width: 0; box-sizing: border-box }
      .connectors-page .connector-env { -webkit-text-security: disc; font-family: monospace }
      .connectors-page .connector-env::placeholder { -webkit-text-security: none }
      .connectors-page .connector-message { overflow-wrap: anywhere; white-space: pre-wrap }
      @media(max-width: 767px) { .connectors-page .btn { min-height: 44px } }
    `}</style>
    <PageHead title="Connectors" sub="Manage the MCP connectors available to each agent">
      <button className="btn" disabled={!!busy} onClick={async () => {
        setBusy('refresh'); setError(null);
        try { await refresh(); } catch (err) { setError(err as Error); } finally { setBusy(null); }
      }}><RefreshCw size={16} strokeWidth={1.5} />{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button>
    </PageHead>
    {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}
    {error ? <ErrorBox error={error} /> : null}
    {res.data?.errors.map((message) => <p key={message} role="alert" className="muted connector-message" style={{ marginBottom: 16 }}>{message}</p>)}
    {(['claude', 'codex'] as const).map((agent) => <section className="panel" key={agent}>
      <div className="panel-head"><h2>{agent === 'claude' ? 'Claude' : 'Codex'}</h2><span className="count">{res.data?.[agent].length ?? ''}</span></div>
      {agent === 'claude' ? <p className="muted" style={{ padding: 16, fontSize: 12 }}>Connectors you added on claude.ai show here when Claude is signed in with your account; manage those on <a href="https://claude.ai" target="_blank" rel="noreferrer">claude.ai</a></p> : null}
      {res.loading ? <SkeletonRows rows={2} /> : null}
      {res.data && !res.data[agent].length ? <Empty title={res.data.errors.some((e) => e.startsWith(agent === 'claude' ? 'Claude' : 'Codex')) ? 'Connector list unavailable' : 'No connectors configured'}>{res.data.errors.some((e) => e.startsWith(agent === 'claude' ? 'Claude' : 'Codex')) ? 'Check the agent installation and sign-in, then refresh' : 'Add a command or URL below and select this agent'}</Empty> : null}
      <ul className="list">{res.data?.[agent].map((connector) => {
        const key = `${agent}:${connector.name}`;
        const color = connector.status === 'connected' ? 'var(--success)' : connector.status === 'failed' ? 'var(--danger)' : connector.status === 'needs-auth' ? 'var(--warning)' : 'var(--text-muted)';
        return <li className="row" key={key}>
          <div className="row-stack"><span className="title">{connector.name.replace(/^plugin:[^:]+:/, '')}</span><span className="mono muted connector-target">{connector.target || 'Target unavailable'}</span>
            {connector.error ? <span className="sub connector-message">{connector.error}</span> : null}
          </div>
          <div className="connector-meta"><span className="chip">{connector.transport}</span><span className="connector-status" style={{ color }}><span className="connector-dot" aria-hidden="true" />{connector.status === 'needs-auth' ? 'Needs authentication' : connector.status[0]!.toUpperCase() + connector.status.slice(1)}</span>{connector.tools !== null ? <span className="muted">{connector.tools} {connector.tools === 1 ? 'tool' : 'tools'}</span> : null}</div>
          {connector.removable ? <div className="connector-actions">{confirm === key ? <><span className="muted" style={{ fontSize: 12 }}>Remove {connector.name}?</span><button className="btn danger" disabled={!!busy} onClick={() => void remove(agent, connector)}>{busy === key ? 'Removing…' : 'Confirm removal'}</button><button className="btn ghost" disabled={!!busy} onClick={() => setConfirm(null)}>Cancel</button></> : <button className="btn ghost" disabled={!!busy} aria-label={`Remove ${connector.name} from ${agent === 'claude' ? 'Claude' : 'Codex'}`} onClick={() => setConfirm(key)}><Trash2 size={16} strokeWidth={1.5} />Remove</button>}</div> : <span className="muted" style={{ fontSize: 12 }}>{connector.scope === 'plugin' ? 'From a Claude plugin' : connector.scope === 'claudeai' ? 'Managed on claude.ai' : 'Managed in Claude Code'}</span>}
        </li>;
      })}</ul>
    </section>)}
    <section className="panel">
      <div className="panel-head"><h2>Add connector</h2></div>
      <form className="panel-body" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <fieldset disabled={!!busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
          <div className="form-grid">
            <div className="field"><label htmlFor="connector-name">Name</label><input className="input" id="connector-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} pattern="[a-zA-Z0-9_-]{1,40}" placeholder="my-connector" autoComplete="off" /></div>
            <div className="field"><label htmlFor="connector-type">Type</label><select className="input" id="connector-type" value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}><option value="stdio">Command</option><option value="http">URL</option></select></div>
            {transport === 'stdio' ? <>
              <div className="field full"><label htmlFor="connector-command">Command and arguments</label><input className="input mono" id="connector-command" value={command} onChange={(e) => setCommand(e.target.value)} placeholder='npx -y @example/mcp-server "folder with spaces"' required autoComplete="off" /><span className="faint" style={{ fontSize: 12 }}>Use quotes around arguments containing spaces</span></div>
              <div className="field full"><label htmlFor="connector-env">Env pairs <span className="faint">(optional)</span></label><textarea className="textarea connector-env" id="connector-env" value={env} onChange={(e) => setEnv(e.target.value)} rows={3} placeholder="KEY=VALUE, one pair per line" autoComplete="off" spellCheck={false} autoCapitalize="off" aria-describedby="connector-env-help" /><span className="faint" id="connector-env-help" style={{ fontSize: 12 }}>Values are masked and cleared after submission</span></div>
            </> : <div className="field full"><label htmlFor="connector-url">URL</label><input className="input mono" id="connector-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://example.com/mcp" autoComplete="off" /></div>}
            <div className="field full"><span className="muted" style={{ fontSize: 12 }}>Add to</span><div className="connector-actions">{(['claude', 'codex'] as const).map((agent) => <label className="connector-check" key={agent}><input type="checkbox" checked={agents[agent]} onChange={(e) => setAgents((previous) => ({ ...previous, [agent]: e.target.checked }))} />{agent === 'claude' ? 'Claude' : 'Codex'}</label>)}</div></div>
          </div>
          <button className="btn primary" type="submit" disabled={!agents.claude && !agents.codex} style={{ marginTop: 16 }}><Plus size={16} strokeWidth={1.5} />{busy === 'add' ? 'Adding…' : 'Add connector'}</button>
        </fieldset>
      </form>
    </section>
    <div aria-live="polite">{results.map((result) => <p className="connector-message" key={result.agent} style={{ color: result.ok ? 'var(--success)' : 'var(--danger)', marginBottom: 8 }}>{result.agent === 'claude' ? 'Claude' : 'Codex'}: {result.message}</p>)}</div>
  </div>;
}
