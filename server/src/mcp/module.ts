import type { Services } from '../app.ts';
import { McpHub } from './hub.ts';

export function mcpOf(s: Services): McpHub {
  const m = s.modules.mcp as McpHub | undefined;
  if (!m) throw new Error('mcp module not set up');
  return m;
}

/** Every run gets the Jarvis MCP server with a per-run token (revoked when the run ends). */
export function setupMcp(s: Services): McpHub {
  const hub = new McpHub(s);
  const mem = s.modules.memory as { vault: McpHub['vault']; proposals: McpHub['proposals'] } | undefined;
  hub.vault = mem?.vault ?? null;
  hub.proposals = mem?.proposals ?? null;
  s.orchestrator.mcpProvider = (runId, taskId) => hub.spec(runId, taskId);
  s.orchestrator.afterRun.push((ctx) => hub.revoke(ctx.run.id));
  s.modules.mcp = hub;
  return hub;
}
