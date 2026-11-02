import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Services } from '../app.ts';
import { all, get } from '../db/index.ts';
import type { MemoryProposals } from '../memory/proposals.ts';
import type { VaultIndex } from '../memory/vault.ts';
import type { McpServerSpec } from '../runners/types.ts';
import type { AgentPref, Project, TaskStatus, TaskType } from '../types.ts';
import { truncateText } from '../util/truncate.ts';

export const STDIO_PATH = fileURLToPath(new URL('./stdio.ts', import.meta.url));

interface RunCtx {
  runId: string;
  taskId: string;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** Issues per-run tokens and executes Jarvis MCP tool calls on behalf of a run. */
export class McpHub {
  private s: Services;
  private tokens = new Map<string, RunCtx & { token: string }>();
  approvalWaitMs = Number(process.env.JARVIS_MCP_APPROVAL_WAIT_MS ?? 10 * 60_000);
  vault: VaultIndex | null = null;
  proposals: MemoryProposals | null = null;

  constructor(s: Services) {
    this.s = s;
  }

  url(): string {
    const host = ['0.0.0.0', '::', ''].includes(this.s.env.bind) ? '127.0.0.1' : this.s.env.bind;
    return `http://${host.includes(':') ? `[${host}]` : host}:${this.s.env.port}`;
  }

  issue(runId: string, taskId: string): string {
    const token = randomBytes(24).toString('hex');
    this.tokens.set(runId, { runId, taskId, token });
    return token;
  }

  revoke(runId: string): void {
    this.tokens.delete(runId);
  }

  spec(runId: string, taskId: string): Record<string, McpServerSpec> {
    return {
      jarvis: {
        command: process.execPath,
        args: [STDIO_PATH, '--run', runId],
        // Under the desktop app, process.execPath is Electron: make it behave as plain Node.
        env: { JARVIS_MCP_URL: this.url(), JARVIS_MCP_TOKEN: this.issue(runId, taskId), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      },
    };
  }

  authenticate(runId: string, token: string): RunCtx | null {
    const ctx = this.tokens.get(runId);
    if (!ctx) return null;
    const a = Buffer.from(ctx.token);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b) ? { runId: ctx.runId, taskId: ctx.taskId } : null;
  }

  async call(ctx: RunCtx, tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const s = this.s;
    const str = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : '');
    switch (tool) {
      case 'search_memory': {
        if (!this.vault) return { text: 'Memory is not available.', isError: true };
        const hits = this.vault.search(str('query'), { limit: Number(args.limit ?? 8), type: str('type') || undefined });
        if (!hits.length) return { text: `No notes match "${str('query')}".` };
        return { text: hits.map((h) => `${h.path} — ${h.title} (${h.tokens} tokens)\n  ${h.snippet.replace(/[\u0001\u0002]/g, '')}`).join('\n') };
      }
      case 'read_note': {
        if (!this.vault) return { text: 'Memory is not available.', isError: true };
        const note = this.vault.read(str('path'));
        if (!note) return { text: `No note at ${str('path')}. Use search_memory to find the right path.`, isError: true };
        return { text: truncateText(note.content).text };
      }
      case 'save_memory': {
        if (!this.proposals) return { text: 'Memory is not available.', isError: true };
        const p = this.proposals.propose({ target: str('target'), content: str('content'), reason: str('reason'), mode: args.mode === 'replace' ? 'replace' : 'append', runId: ctx.runId });
        return { text: p.status === 'applied' ? `Saved to ${p.target_path}.` : `Proposed a change to ${p.target_path} (id ${p.id}); the owner will review it. Continue with your task.` };
      }
      case 'request_approval': {
        const { approval, decision } = s.approvals.request({
          runId: ctx.runId,
          taskId: ctx.taskId,
          kind: str('kind') || 'request',
          summary: str('summary') || 'Agent request',
          reason: str('reason'),
          detail: { tool: 'request_approval', input: { command: str('payload') }, agent: get<{ agent: string }>(s.db, 'SELECT agent FROM runs WHERE id = ?', ctx.runId)?.agent ?? null, runId: ctx.runId },
        });
        const t = s.tasks.get(ctx.taskId);
        if (t?.status === 'running') s.tasks.setStatus(ctx.taskId, 'needs_you');
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>((r) => (timer = setTimeout(() => r(null), this.approvalWaitMs)));
        const d = await Promise.race([decision, timeout]);
        clearTimeout(timer);
        const cur = s.tasks.get(ctx.taskId);
        if (!d) {
          s.approvals.detach(approval.id);
          return { text: `PENDING: approval ${approval.id} is waiting for the owner. Do not perform the action. Finish now with a summary; Jarvis will resume this session once the owner decides.` };
        }
        if (cur?.status === 'needs_you' && s.orchestrator.isActive(ctx.taskId)) s.tasks.setStatus(ctx.taskId, 'running');
        return d.approved
          ? { text: `APPROVED${d.note ? ` (owner note: ${d.note})` : ''}. Go ahead with exactly: ${str('summary')}` }
          : { text: `REJECTED${d.note ? `: ${d.note}` : ''}. Do not perform this action; continue without it or finish.` };
      }
      case 'create_task': {
        const project = str('project') ? get<Project>(s.db, 'SELECT * FROM projects WHERE lower(name) = lower(?)', str('project')) : undefined;
        const t = s.tasks.create({
          title: str('title'),
          body: str('body'),
          type: (str('type') || undefined) as TaskType | undefined,
          project_id: project?.id,
          agent_pref: (str('agent') || 'auto') as AgentPref,
          parent_id: ctx.taskId,
          run: args.run !== false,
        });
        if (t.status === 'queued') s.orchestrator.tick();
        return { text: `Created task ${t.id} (${t.status}): ${t.title}` };
      }
      case 'update_task_status': {
        const id = str('task_id');
        if (id === ctx.taskId) return { text: 'Your own task finishes when you finish; just complete your work.', isError: true };
        if (!s.tasks.get(id)) return { text: `No task ${id}.`, isError: true };
        const status = str('status') as TaskStatus;
        if (str('summary')) s.tasks.patch(id, { result_summary: str('summary') });
        if (status === 'queued') s.orchestrator.enqueue(id);
        else if (status === 'cancelled') await s.orchestrator.cancel(id);
        else s.tasks.move(id, status);
        return { text: `Task ${id} is now ${s.tasks.get(id)?.status}.` };
      }
      case 'notify_owner': {
        const t = s.tasks.get(ctx.taskId);
        s.bus.publish('notify', { message: str('message').slice(0, 1000), level: args.level === 'warning' ? 'warning' : 'info', taskId: ctx.taskId, taskTitle: t?.title ?? null, runId: ctx.runId });
        return { text: 'Notification sent.' };
      }
      case 'list_projects': {
        const rows = all<Project>(s.db, 'SELECT * FROM projects ORDER BY kind, name');
        return { text: rows.map((p) => `${p.name} (${p.kind})${p.vault_note ? ` — note: ${p.vault_note}` : ''}${p.repo ? ` — repo: ${p.repo}` : ''}`).join('\n') || 'No projects yet.' };
      }
      case 'get_usage': {
        const u = s.usage.current();
        const line = (agent: 'claude' | 'codex') =>
          `${agent}: 5h ${u[agent].five_hour ? `${Math.round(u[agent].five_hour!.usedPercent)}%` : 'unknown'}, weekly ${u[agent].weekly ? `${Math.round(u[agent].weekly!.usedPercent)}%` : 'unknown'}`;
        return { text: `${line('claude')}\n${line('codex')}\nRouter falls back at ${s.config.get().router.fallbackAtPercent}%.` };
      }
      default:
        return { text: `Unknown tool ${tool}.`, isError: true };
    }
  }
}
