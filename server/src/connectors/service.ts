import { execFile } from 'node:child_process';
import { claudeBinary, codexEntry } from '../util/agentBins.ts';
import { sanitizedAgentEnv } from '../util/env.ts';

type Agent = 'claude' | 'codex';
export interface Connector {
  name: string;
  agent: Agent;
  transport: 'stdio' | 'http' | 'sse' | 'unknown';
  target: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled' | 'configured';
  scope: string | null;
  tools: number | null;
  error: string | null;
  removable: boolean;
}
export interface ClaudeMcpStatus {
  name: string; status: string; scope?: string; source?: string; error?: string;
  config?: { type?: string; command?: string; url?: string }; tools?: unknown[];
}
export type ExecFn = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;
export const realExec: ExecFn = (file, args, opts) => new Promise((resolve) => {
  execFile(file, args, { timeout: opts.timeoutMs, windowsHide: true, env: sanitizedAgentEnv(), maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
  });
});
export default realExec;

export interface AddConnectorInput {
  name: string; agents: Agent[]; transport: 'stdio' | 'http'; command?: string;
  args?: string[]; url?: string; env?: Record<string, string>;
}
export interface ConnectorResult { agent: Agent; ok: boolean; message: string }
interface Listing { claude: Connector[]; codex: Connector[]; errors: string[] }
// A leading dash would be interpreted as a CLI option rather than a connector name.
const validName = (name: unknown): name is string => typeof name === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(name) && !name.startsWith('-');
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
function host(url: unknown): string {
  try { const u = new URL(text(url)); return ['http:', 'https:'].includes(u.protocol) ? u.host : ''; } catch { return ''; }
}
function command(value: unknown): string {
  // Paths are useful, but never expose embedded arguments or URL credentials.
  const first = text(value).trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  const bin = first?.[1] ?? first?.[2] ?? first?.[3] ?? '';
  return bin.includes('://') || bin.includes('=') ? '' : bin;
}
function transport(value: unknown, config: Record<string, unknown>): Connector['transport'] {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value;
  return config.command ? 'stdio' : config.url ? 'http' : 'unknown';
}
function validate(input: AddConnectorInput): void {
  if (!input || !validName(input.name)) throw new Error('Use 1–40 letters, numbers, underscores or hyphens; do not start with a hyphen');
  if (!Array.isArray(input.agents) || !input.agents.length || input.agents.some((a) => a !== 'claude' && a !== 'codex')) throw new Error('Select Claude or Codex');
  if (input.transport !== 'stdio' && input.transport !== 'http') throw new Error('Choose Command or URL');
  if (input.transport === 'stdio' && (typeof input.command !== 'string' || !input.command.trim() || input.command.startsWith('-') || /[\r\n\0]/.test(input.command))) throw new Error('Provide a command');
  if (input.transport === 'http' && !host(input.url)) throw new Error('Provide an http(s) URL');
  if (input.args !== undefined && (!Array.isArray(input.args) || input.args.length > 20 || input.args.some((a) => typeof a !== 'string' || a.includes('\0')))) throw new Error('Use at most 20 string arguments');
  if (input.env !== undefined && (input.env === null || typeof input.env !== 'object' || Array.isArray(input.env) || Object.entries(input.env).length > 20 || Object.entries(input.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== 'string' || v.includes('\0')))) throw new Error('Use at most 20 env pairs with valid variable names');
  if (input.transport === 'http' && Object.keys(input.env ?? {}).length) throw new Error('Env pairs are supported for commands only');
}

export class ConnectorService {
  private exec: ExecFn;
  private claudeStatus: () => Promise<ClaudeMcpStatus[]>;
  private cache: { at: number; value: Listing } | null = null;

  constructor(options: { exec: ExecFn; claudeStatus: () => Promise<ClaudeMcpStatus[]> }) {
    this.exec = options.exec;
    this.claudeStatus = options.claudeStatus;
  }

  private async run(agent: Agent, args: string[]) {
    const entry = agent === 'claude' ? claudeBinary() : codexEntry();
    if (!entry) throw new Error(`${agent === 'claude' ? 'Claude Code' : 'Codex'} is not installed`);
    return this.exec(agent === 'claude' ? entry : process.execPath, agent === 'claude' ? args : [entry, ...args], { timeoutMs: 30_000 });
  }

  async list(options: { fresh?: boolean } = {}): Promise<Listing> {
    if (!options.fresh && this.cache && Date.now() - this.cache.at < 30_000) return structuredClone(this.cache.value);
    const value: Listing = { claude: [], codex: [], errors: [] };
    await Promise.all([
      (async () => {
        try {
          const entries = await this.claudeStatus();
          value.claude = entries.filter((e) => e.name !== 'jarvis').map((e) => {
            const config = record(e.config);
            const status: Connector['status'] = e.status === 'needs_auth' ? 'needs-auth' : ['connected', 'failed', 'needs-auth', 'pending', 'disabled'].includes(e.status) ? e.status as Connector['status'] : 'configured';
            const remote = e.scope === 'claudeai' || e.source === 'claudeai';
            // Plugin connectors come and go with their plugin; `claude mcp remove` cannot remove them.
            const plugin = e.source === 'plugin' || e.name.startsWith('plugin:');
            const scope = remote ? 'claudeai' : plugin ? 'plugin' : e.scope ?? e.source ?? null;
            return { name: e.name, agent: 'claude', transport: transport(config.type, config), target: config.command ? command(config.command) : host(config.url), status, scope, tools: Array.isArray(e.tools) ? e.tools.length : null, error: e.error ? 'Connection failed; check the connector in Claude Code' : null, removable: !remote && !plugin && (e.scope === 'user' || e.scope === undefined) };
          });
        } catch { value.errors.push('Claude connectors could not be loaded; check Claude sign-in and refresh'); }
      })(),
      (async () => {
        try {
          const result = await this.run('codex', ['mcp', 'list', '--json']);
          let rows: unknown;
          if (result.code === 0) {
            try { rows = JSON.parse(result.stdout); } catch { rows = undefined; }
          }
          if (rows === undefined) {
            const fallback = await this.run('codex', ['mcp', 'list']);
            if (fallback.code !== 0) throw new Error('list failed');
            rows = this.table(fallback.stdout);
          }
          if (!Array.isArray(rows)) {
            const wrapper = record(rows);
            rows = wrapper.servers ?? wrapper.mcp_servers;
          }
          if (!Array.isArray(rows)) throw new Error('Invalid connector list');
          value.codex = rows.flatMap((raw): Connector[] => {
            const e = record(raw);
            if (!text(e.name) || e.name === 'jarvis') return [];
            const config = Object.keys(record(e.transport)).length ? record(e.transport) : e;
            return [{ name: text(e.name), agent: 'codex', transport: transport(config.type ?? e.type, config), target: config.command ? command(config.command) : host(config.url), status: 'configured', scope: null, tools: null, error: null, removable: true }];
          });
        } catch { value.errors.push('Codex connectors could not be loaded; check the Codex installation and refresh'); }
      })(),
    ]);
    this.cache = { at: Date.now(), value };
    return structuredClone(value);
  }

  private table(output: string): unknown[] {
    const rows: unknown[] = [];
    let columns: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      const cells = line.trim().split(/\s{2,}|\t+/);
      if (cells[0] === 'Name') { columns = cells; continue; }
      if (!line.trim() || /^No MCP servers/i.test(line)) continue;
      if (!columns.length) throw new Error('Unrecognized connector table');
      if (!validName(cells[0])) continue;
      const url = cells[columns.indexOf('Url')] ?? cells[columns.indexOf('URL')];
      rows.push({ name: cells[0], command: cells[columns.indexOf('Command')], url });
    }
    return rows;
  }

  async add(input: AddConnectorInput): Promise<ConnectorResult[]> {
    validate(input);
    const env = Object.entries(input.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const secrets = [...Object.values(input.env ?? {}), ...(input.args ?? []), input.url ?? ''].filter(Boolean).sort((a, b) => b.length - a.length);
    const results: ConnectorResult[] = [];
    for (const agent of new Set(input.agents)) {
      const args = agent === 'claude' ? ['mcp', 'add', '--scope', 'user'] : ['mcp', 'add'];
      if (input.transport === 'http') {
        args.push(...(agent === 'claude' ? ['--transport', 'http', input.name, input.url!] : [input.name, '--url', input.url!]));
      } else {
        if (agent === 'codex') args.push(input.name);
        for (const pair of env) args.push(agent === 'claude' ? '-e' : '--env', pair);
        if (agent === 'claude') args.push(input.name);
        args.push('--', input.command!, ...(input.args ?? []));
      }
      results.push(await this.mutate(agent, args, 'Connector added', secrets));
    }
    return results;
  }

  async remove(agent: Agent, name: string): Promise<ConnectorResult> {
    if (agent !== 'claude' && agent !== 'codex') throw new Error('Choose Claude or Codex');
    if (!validName(name) || name === 'jarvis') throw new Error('Choose a valid removable connector');
    if (agent === 'claude') {
      const entries = await this.list({ fresh: true });
      if (entries.errors.some((e) => e.startsWith('Claude'))) return { agent, ok: false, message: 'Cannot verify connector scope; refresh Claude before removing' };
      if (entries.claude.some((e) => e.name === name && !e.removable)) return { agent, ok: false, message: 'Manage this connector on claude.ai' };
    }
    return this.mutate(agent, agent === 'claude' ? ['mcp', 'remove', '--scope', 'user', name] : ['mcp', 'remove', name], 'Connector removed', []);
  }

  private async mutate(agent: Agent, args: string[], success: string, secrets: string[]): Promise<ConnectorResult> {
    this.cache = null;
    try {
      const result = await this.run(agent, args);
      let message = result.code === 0 ? success : result.stderr.trim() || 'The connector command failed; check the agent installation';
      for (const secret of secrets) message = message.split(secret).join('[redacted]');
      // CLI diagnostics may contain unrelated configured credentials. Never return those lines.
      if (/https?:\/\/|(?:token|secret|password|authorization|api.key)\s*[:=]/i.test(message)) message = 'The connector command failed; check the agent configuration';
      return { agent, ok: result.code === 0, message: message.slice(0, 400) };
    } catch { return { agent, ok: false, message: 'Could not run the connector command; check the agent installation' }; }
    finally { this.cache = null; }
  }
}
