/**
 * Jarvis MCP server over stdio (newline-delimited JSON-RPC 2.0). Started by Claude Code / Codex for
 * each run: `node server/src/mcp/stdio.ts --run <id>`. Forwards tool calls to the Jarvis server
 * on localhost with the run's token. No dependencies.
 */
import { createInterface } from 'node:readline';
import { TOOL_DEFS } from './tools.ts';

const runIdx = process.argv.indexOf('--run');
const RUN_ID = runIdx >= 0 ? process.argv[runIdx + 1] : '';
const URL_BASE = process.env.JARVIS_MCP_URL ?? 'http://127.0.0.1:4317';
const TOKEN = process.env.JARVIS_MCP_TOKEN ?? '';

const INSTRUCTIONS = 'Jarvis tools: look things up with search_memory/read_note, propose memory with save_memory, and call request_approval before anything outward-facing.';

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const res = await fetch(`${URL_BASE}/api/mcp/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-jarvis-run': RUN_ID, 'x-jarvis-mcp-token': TOKEN },
      body: JSON.stringify({ tool: name, args }),
    });
    const data = (await res.json()) as { text?: string; isError?: boolean; message?: string };
    if (!res.ok) return { content: [{ type: 'text', text: data.message ?? `Jarvis returned ${res.status}` }], isError: true };
    return { content: [{ type: 'text', text: data.text ?? '' }], isError: data.isError === true };
  } catch (err) {
    return { content: [{ type: 'text', text: `Jarvis is not reachable: ${(err as Error).message}` }], isError: true };
  }
}

export async function handle(msg: { id?: number | string | null; method?: string; params?: Record<string, any> }): Promise<unknown | null> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  if (id === undefined || id === null) return null; // notification
  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'jarvis', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOL_DEFS });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      if (!TOOL_DEFS.some((t) => t.name === name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
      return reply(await callTool(name, (params?.arguments ?? {}) as Record<string, unknown>));
    }
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('stdio.ts')) {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    void handle(msg).then((r) => r && send(r));
  });
  rl.on('close', () => process.exit(0));
}
