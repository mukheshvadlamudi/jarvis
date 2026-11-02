import { spawn } from 'node:child_process';
import { serve } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { mcpOf } from '../src/mcp/module.ts';
import { STDIO_PATH } from '../src/mcp/hub.ts';
import { handle } from '../src/mcp/stdio.ts';
import { makeCtx, waitFor } from './helpers.ts';
import type { TestCtx } from './helpers.ts';

let ctx: TestCtx;
afterEach(async () => ctx?.close());

async function call(tool: string, args: Record<string, unknown>, run: string, token: string) {
  const res = await ctx.app.request('/api/mcp/call', { method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-run': run, 'x-jarvis-mcp-token': token }, body: JSON.stringify({ tool, args }) });
  return { status: res.status, json: (await res.json()) as { text: string; isError?: boolean } };
}

describe('Jarvis MCP', () => {
  it('speaks MCP over JSON-RPC', async () => {
    const init = (await handle({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe('jarvis');
    const list = (await handle({ id: 2, method: 'tools/list' })) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual(['create_task', 'get_usage', 'list_projects', 'notify_owner', 'read_note', 'request_approval', 'save_memory', 'search_memory', 'update_task_status']);
    expect(await handle({ method: 'notifications/initialized' })).toBeNull();
    expect(((await handle({ id: 3, method: 'nope' })) as { error: { code: number } }).error.code).toBe(-32601);
  });

  it('gives each run its own token and serves memory tools', async () => {
    ctx = makeCtx();
    const hub = mcpOf(ctx.s);
    const spec = hub.spec('r_1', 't_1');
    expect(spec.jarvis.args).toEqual([STDIO_PATH, '--run', 'r_1']);
    const token = spec.jarvis.env.JARVIS_MCP_TOKEN;
    expect((await call('get_usage', {}, 'r_1', 'wrong')).status).toBe(401);
    const search = await call('search_memory', { query: 'Umami' }, 'r_1', token);
    expect(search.json.text).toContain('Research/2026-11-01-privacy-analytics.md');
    const note = await call('read_note', { path: 'People/Sam Okafor.md' }, 'r_1', token);
    expect(note.json.text).toContain('Tuesdays/Thursdays');
    const save = await call('save_memory', { target: 'People/Sam Okafor.md', content: '- Prefers WhatsApp for quick questions', reason: 'Said on the call' }, 'r_1', token);
    expect(save.json.text).toMatch(/Proposed a change/);
    expect((await call('list_projects', {}, 'r_1', token)).json.text).toBe('No projects yet.');
    hub.revoke('r_1');
    expect((await call('get_usage', {}, 'r_1', token)).status).toBe(401);
  });

  it('request_approval waits for the owner, and falls back to resume-on-approve', async () => {
    ctx = makeCtx({ mockDelayMs: 1 });
    const t = ctx.s.tasks.create({ title: 'Email Priya the invoice', run: false });
    const hub = mcpOf(ctx.s);
    const token = hub.issue('r_x', t.id);
    const pending = call('request_approval', { summary: 'Send invoice email to Priya', reason: 'She asked', payload: 'to: priya@x' }, 'r_x', token);
    await waitFor(() => ctx.s.approvals.list('pending').length === 1);
    const a = ctx.s.approvals.list('pending')[0];
    await ctx.req('POST', `/api/approvals/${a.id}`, { decision: 'approved' });
    expect((await pending).json.text).toMatch(/^APPROVED/);

    hub.approvalWaitMs = 20;
    const timedOut = await call('request_approval', { summary: 'Post to LinkedIn', reason: 'launch', payload: 'text' }, 'r_x', token);
    expect(timedOut.json.text).toMatch(/^PENDING/);
    const b = ctx.s.approvals.list('pending')[0];
    await ctx.req('POST', `/api/approvals/${b.id}`, { decision: 'approved' });
    await waitFor(() => ctx.s.orchestrator.runsForTask(t.id).length === 1);
    expect(ctx.s.orchestrator.runsForTask(t.id)[0].prompt).toMatch(/owner approved: Post to LinkedIn/);
  });

  it('creates follow-up tasks and notifies', async () => {
    ctx = makeCtx();
    const t = ctx.s.tasks.create({ title: 'Parent', run: false });
    const token = mcpOf(ctx.s).issue('r_y', t.id);
    const seen: unknown[] = [];
    ctx.s.bus.subscribe((e) => e.type === 'notify' && seen.push(e.data));
    const r = await call('create_task', { title: 'Check staging container', run: false }, 'r_y', token);
    expect(r.json.text).toMatch(/Created task t_\w+ \(inbox\)/);
    expect(ctx.s.tasks.list({ status: 'inbox' }).find((x) => x.title === 'Check staging container')?.parent_id).toBe(t.id);
    expect((await call('update_task_status', { task_id: t.id, status: 'done' }, 'r_y', token)).json.isError).toBe(true);
    await call('notify_owner', { message: 'Staging is back up' }, 'r_y', token);
    expect(seen).toEqual([expect.objectContaining({ message: 'Staging is back up', taskTitle: 'Parent' })]);
  });

  it('the stdio bridge round-trips a real tool call to the server', async () => {
    ctx = makeCtx();
    const server = serve({ fetch: ctx.app.fetch, hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const token = mcpOf(ctx.s).issue('r_s', 't_s');
    const child = spawn(process.execPath, [STDIO_PATH, '--run', 'r_s'], { env: { ...process.env, JARVIS_MCP_URL: `http://127.0.0.1:${port}`, JARVIS_MCP_TOKEN: token } });
    const lines: string[] = [];
    child.stdout.on('data', (d) => lines.push(...String(d).split('\n').filter(Boolean)));
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_note', arguments: { path: 'Inbox.md' } } })}\n`);
    await waitFor(() => lines.length > 0, 8000);
    child.kill();
    server.close();
    const msg = JSON.parse(lines[0]);
    expect(msg.result.content[0].text).toContain('# Inbox');
  });
});
