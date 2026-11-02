import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerConnectorRoutes } from '../src/api/connectors.ts';
import type { Services } from '../src/app.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import type { AddConnectorInput, ClaudeMcpStatus, ExecFn } from '../src/connectors/service.ts';

vi.mock('../src/util/agentBins.ts', () => ({ claudeBinary: () => '/fake/claude', codexEntry: () => '/fake/codex.js' }));
afterEach(() => vi.restoreAllMocks());

function setup(status: ClaudeMcpStatus[] = []) {
  const exec = vi.fn<ExecFn>().mockResolvedValue({ code: 0, stdout: '[]', stderr: '' });
  const claudeStatus = vi.fn(async () => status);
  return { exec, claudeStatus, service: new ConnectorService({ exec, claudeStatus }) };
}
const base: AddConnectorInput = { name: 'docs', agents: ['claude', 'codex'], transport: 'stdio', command: 'node', args: ['server.js', '--token', 'hidden-arg'], env: { TOKEN: 'hidden-env' } };

describe('connectors', () => {
  it('maps both agents, exposes safe targets and hides jarvis', async () => {
    const { exec, service } = setup([
      { name: 'jarvis', status: 'connected' },
      { name: 'docs', status: 'connected', scope: 'user', config: { type: 'http', url: 'https://user:password@docs.example/mcp?token=secret' }, tools: [{}, {}] },
      { name: 'local', status: 'failed', config: { type: 'stdio', command: 'node --secret hidden' }, error: 'Bearer secret' },
    ]);
    exec.mockResolvedValue({ code: 0, stdout: JSON.stringify([{ name: 'files', transport: { type: 'stdio', command: 'npx', args: ['secret'], env: { TOKEN: 'secret' } } }, { name: 'jarvis' }, { name: 'remote', transport: { type: 'streamable_http', url: 'https://u:secret@remote.example/mcp?key=secret', headers: { authorization: 'secret' } } }]), stderr: '' });
    const result = await service.list();
    expect(result.claude).toHaveLength(2);
    expect(result.claude[0]).toMatchObject({ transport: 'http', target: 'docs.example', tools: 2, status: 'connected', scope: 'user' });
    expect(result.claude[1]).toMatchObject({ target: 'node', status: 'failed' });
    expect(result.codex.map((c) => c.target)).toEqual(['npx', 'remote.example']);
    expect(result.codex.every((c) => c.status === 'configured')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/secret|password|hidden|Bearer/);
    expect(exec).toHaveBeenCalledWith(process.execPath, ['/fake/codex.js', 'mcp', 'list', '--json'], { timeoutMs: 30_000 });
  });

  it('refuses removal for claude.ai scopes and sources', async () => {
    const { service, exec } = setup([{ name: 'remote', status: 'connected', scope: 'claudeai' }, { name: 'remote2', status: 'connected', source: 'claudeai', scope: 'user' }]);
    expect((await service.list()).claude.every((c) => !c.removable)).toBe(true);
    expect(await service.remove('claude', 'remote')).toMatchObject({ ok: false, message: expect.stringContaining('claude.ai') });
    expect(await service.remove('claude', 'remote2')).toMatchObject({ ok: false });
    expect(exec.mock.calls.every(([, args]) => !args.includes('remove'))).toBe(true);
  });

  it.each([
    { name: '../bad' }, { name: '-bad' }, { name: 'a'.repeat(41) }, { command: '' }, { agents: [] }, { agents: ['other'] },
    { transport: 'sse' }, { transport: 'http', url: 'file:///secret' }, { transport: 'http', url: 'bad' },
    { args: Array(21).fill('x') }, { env: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`K${i}`, 'x'])) },
    { env: { 'bad-key': 'x' } }, { env: { TOKEN: 5 } }, { args: [5] },
  ])('validates add input before exec: %j', async (patch) => {
    const { service, exec } = setup();
    await expect(service.add({ ...base, ...patch } as AddConnectorInput)).rejects.toThrow();
    expect(exec).not.toHaveBeenCalled();
  });

  it('builds exact stdio argv for both agents', async () => {
    const { service, exec } = setup();
    expect((await service.add(base)).every((r) => r.ok)).toBe(true);
    expect(exec.mock.calls).toEqual([
      ['/fake/claude', ['mcp', 'add', '--scope', 'user', '-e', 'TOKEN=hidden-env', 'docs', '--', 'node', 'server.js', '--token', 'hidden-arg'], { timeoutMs: 30_000 }],
      [process.execPath, ['/fake/codex.js', 'mcp', 'add', 'docs', '--env', 'TOKEN=hidden-env', '--', 'node', 'server.js', '--token', 'hidden-arg'], { timeoutMs: 30_000 }],
    ]);
  });

  it('builds exact http argv for both agents', async () => {
    const { service, exec } = setup();
    await service.add({ name: 'docs', agents: ['claude', 'codex'], transport: 'http', url: 'https://docs.example/mcp' });
    expect(exec.mock.calls).toEqual([
      ['/fake/claude', ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'docs', 'https://docs.example/mcp'], { timeoutMs: 30_000 }],
      [process.execPath, ['/fake/codex.js', 'mcp', 'add', 'docs', '--url', 'https://docs.example/mcp'], { timeoutMs: 30_000 }],
    ]);
  });

  it('redacts env values and args, caps diagnostics and ignores success stdout', async () => {
    const { service, exec } = setup();
    exec.mockResolvedValue({ code: 1, stdout: 'hidden-env', stderr: ` hidden-env hidden-arg ${'x'.repeat(600)} ` });
    const results = await service.add(base);
    expect(JSON.stringify(results)).not.toMatch(/hidden-env|hidden-arg/);
    expect(results.every((r) => !r.ok && r.message.length <= 400 && r.message.includes('[redacted]'))).toBe(true);
    exec.mockResolvedValue({ code: 0, stdout: 'hidden-env', stderr: 'hidden-env' });
    expect(JSON.stringify(await service.add(base))).not.toContain('hidden-env');
    exec.mockRejectedValue(new Error('hidden-env'));
    expect(JSON.stringify(await service.add(base))).not.toContain('hidden-env');
  });

  it('reports Claude failure while listing Codex and Codex failure while listing Claude', async () => {
    const { service, exec, claudeStatus } = setup([{ name: 'docs', status: 'connected' }]);
    claudeStatus.mockRejectedValueOnce(new Error('private-token'));
    exec.mockResolvedValueOnce({ code: 0, stdout: '[{"name":"files","transport":{"type":"stdio","command":"node"}}]', stderr: '' });
    const first = await service.list();
    expect(first.errors).toHaveLength(1); expect(first.codex).toHaveLength(1); expect(first.claude).toEqual([]);
    exec.mockRejectedValue(new Error('private-token'));
    const next = await service.list({ fresh: true });
    expect(next.errors).toHaveLength(1); expect(next.claude).toHaveLength(1); expect(next.codex).toEqual([]);
    expect(JSON.stringify([first, next])).not.toContain('private-token');
  });

  it('falls back to text tables, ignoring args, env and URL secrets', async () => {
    const { service, exec } = setup();
    exec.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'unknown flag' }).mockResolvedValueOnce({ code: 0, stdout: 'Name  Command  Args  Env  Status\nfiles  node  --token secret  KEY=secret  enabled\n\nName  Url  Bearer Token Env Var  Status\ndocs  https://u:secret@docs.example/mcp?secret  TOKEN  enabled', stderr: '' });
    const result = await service.list();
    expect(result.errors).toEqual([]);
    expect(result.codex.map((c) => c.target)).toEqual(['node', 'docs.example']);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('caches for 30 seconds, refreshes explicitly and invalidates after mutations', async () => {
    const { service, exec } = setup();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await service.list(); await service.list(); expect(exec).toHaveBeenCalledTimes(1);
    await service.list({ fresh: true }); expect(exec).toHaveBeenCalledTimes(2);
    now.mockReturnValue(31_001); await service.list(); expect(exec).toHaveBeenCalledTimes(3);
    await service.add(base); await service.list(); expect(exec).toHaveBeenCalledTimes(6);
  });

  it('removes with the correct argv and refuses invalid names', async () => {
    const { service, exec } = setup([{ name: 'docs', status: 'connected', scope: 'user' }]);
    await service.remove('claude', 'docs'); await service.remove('codex', 'docs');
    expect(exec).toHaveBeenCalledWith('/fake/claude', ['mcp', 'remove', '--scope', 'user', 'docs'], { timeoutMs: 30_000 });
    expect(exec).toHaveBeenCalledWith(process.execPath, ['/fake/codex.js', 'mcp', 'remove', 'docs'], { timeoutMs: 30_000 });
    await expect(service.remove('claude', '--all')).rejects.toThrow();
  });

  it('returns 503 when unavailable and blocks agent mutation requests', async () => {
    const app = new Hono();
    const modules: Record<string, unknown> = {};
    registerConnectorRoutes(app, { modules } as Services);
    expect((await app.request('/api/connectors')).status).toBe(503);
    expect((await app.request('/api/connectors', { method: 'POST' })).status).toBe(503);
    modules.connectors = setup().service;
    expect((await app.request('/api/connectors', { method: 'POST', headers: { 'x-jarvis-run': 'agent-run' } })).status).toBe(403);
    expect((await app.request('/api/connectors?fresh=1')).status).toBe(200);
    expect((await app.request('/api/connectors/bad/docs', { method: 'DELETE' })).status).toBe(400);
  });
});
