import { api } from '../../lib/api.ts';
import { subscribeLive } from '../../lib/live.ts';
import type { LiveEvent } from '../../lib/live.ts';

interface UsageWin { usedPercent: number; resetsAt: string | null }
interface AgentSummary { state: string; detail?: string; busy?: Array<{ title: string }>; usage: { five_hour: UsageWin | null; weekly: UsageWin | null } }

/** "in 2 hours 10 minutes" — speakable, no timestamps. */
export function resetsIn(iso: string | null): string {
  if (!iso) return 'unknown';
  const ms = Date.parse(iso) - Date.now();
  if (!(ms > 0)) return 'now';
  const h = Math.floor(ms / 3600_000);
  const m = Math.round((ms % 3600_000) / 60_000);
  if (h >= 48) return `in ${Math.round(h / 24)} days`;
  return h ? `in ${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minutes` : ''}` : `in ${m} minutes`;
}

export interface AgentRun { id: string; agent: string; status: string; answer?: string | null; error?: string | null; started_at?: string; owner_text?: string; }
export type Request = <T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<T>;
export const plainAnswer = (text: string) => text.replace(/```[\s\S]*?```/g, ' [Code is on screen] ').replace(/!?(?:\[([^\]]*)\])\([^)]*\)/g, '$1').replace(/<[^>]*>/g, '').replace(/^[\s]*[#>*-]+\s*/gm, '').replace(/[*_`~]/g, '').trim();

export class VoiceTools {
  conversationId: string | null;
  onRun: ((id: string) => void) | null = null;
  private request: Request;
  private subscribe: typeof subscribeLive;
  private changed: (id: string) => void;
  private pending = new Set<() => void>();
  constructor(id: string | null, changed: (id: string) => void, request: Request = api, subscribe = subscribeLive) {
    this.conversationId = id; this.request = request; this.subscribe = subscribe; this.changed = changed;
  }
  private text(args: Record<string, unknown>, key: string) {
    const value = args[key]; if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw new Error(`Supply ${key}, between 1 and 20000 characters.`);
    return value.trim();
  }
  async handle(name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (name === 'search_memory') {
      const r = await this.request<{ results: Array<{ title: string; snippet?: string }> }>(`/api/memory/search?q=${encodeURIComponent(this.text(args, 'query'))}&limit=5`, { signal });
      return { results: r.results.slice(0, 5).map((r) => ({ title: r.title, snippet: (r.snippet ?? '').slice(0, 350) })) };
    }
    if (name === 'remember') return this.request('/api/memory/remember', { method: 'POST', body: { text: this.text(args, 'text'), source: 'Voice' }, signal });
    if (name === 'get_status') {
      const agents = await this.request<{ agents: Record<string, AgentSummary> }>('/api/agents', { signal });
      const detail = this.conversationId ? await this.request<{ runs: AgentRun[] }>(`/api/conversations/${this.conversationId}`, { signal }) : { runs: [] };
      return {
        agents: Object.entries(agents.agents).map(([agent, s]) => ({ agent, state: s.state, detail: s.detail, working_on: (s.busy ?? []).map((b) => b.title) })),
        active: detail.runs.filter((r) => r.status === 'running').map(({ id, agent }) => ({ id, agent })),
      };
    }
    if (name === 'get_usage') {
      const agents = await this.request<{ agents: Record<string, AgentSummary> }>('/api/agents', { signal });
      const voice = await this.request<{ inSec?: number; outSec?: number }>('/api/voice/live/usage', { signal }).catch(() => ({ inSec: 0, outSec: 0 }));
      const win = (w: UsageWin | null | undefined) => (w ? { used_percent: Math.round(w.usedPercent), resets_in: resetsIn(w.resetsAt) } : 'not reported yet');
      return {
        claude: { five_hour: win(agents.agents.claude?.usage.five_hour), weekly: win(agents.agents.claude?.usage.weekly) },
        codex: { five_hour: win(agents.agents.codex?.usage.five_hour), weekly: win(agents.agents.codex?.usage.weekly) },
        voice_today_minutes: Math.round(((voice.inSec ?? 0) + (voice.outSec ?? 0)) / 60),
      };
    }
    if (name === 'stop_agent') {
      if (!this.conversationId) return { status: 'idle' };
      await this.request(`/api/tasks/${this.conversationId}/cancel`, { method: 'POST', signal }); return { status: 'cancelled' };
    }
    if (name !== 'ask_agent') throw new Error(`Unknown voice tool: ${name}`);
    const text = this.text(args, 'request');
    const agent = args.agent ?? 'auto';
    if (!['auto', 'claude', 'codex'].includes(String(agent))) throw new Error('Choose auto, claude or codex.');
    // Subscribe before posting: a mock or quick answer can finish before the POST returns.
    return new Promise((resolve, reject) => {
      let runId: string | undefined; let cid = this.conversationId;
      let done = false; let checking = false;
      const seen = new Map<string, AgentRun>();
      const finish = (run: AgentRun) => {
        if (done || !runId || run.id !== runId || run.status === 'running') return;
        done = true; cleanup();
        resolve({ status: run.status, agent: run.agent, answer: plainAnswer(run.answer ?? run.error ?? '').slice(0, 1500) });
      };
      const reconcile = async () => {
        if (!cid || !runId || checking || done) return;
        checking = true;
        try { const detail = await this.request<{ runs: AgentRun[] }>(`/api/conversations/${cid}`, { signal }); const run = detail.runs.find((r) => r.id === runId); if (run) finish(run); }
        catch (error) { if (!done) { done = true; cleanup(); reject(error); } }
        finally { checking = false; }
      };
      const unsub = this.subscribe((event: LiveEvent) => {
        if (event.type === 'run.finished') { seen.set(event.data.id, event.data); finish(event.data); }
        if (event.type === 'hello' || event.type === 'reconcile') void reconcile();
      });
      const abort = () => { if (!done) { done = true; cleanup(); reject(new Error('Voice tool cancelled')); } };
      const timer = setTimeout(() => { if (!done) { done = true; cleanup(); reject(new Error('Agent is taking longer than expected. The work remains on screen.')); } }, 30 * 60_000);
      const cleanup = () => { unsub(); clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(abort); };
      this.pending.add(abort); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      void (async () => {
        try {
          // Let the POST return its identity even after cancellation, so a new run cannot be orphaned.
          const response = await this.request<{ runId?: string; conversation: { id: string } }>(cid ? `/api/conversations/${cid}/messages` : '/api/conversations', { method: 'POST', body: { text, agent } });
          if (done) {
            if (signal?.aborted) await this.request(`/api/tasks/${response.conversation.id}/cancel`, { method: 'POST' });
            return;
          }
          cid = response.conversation.id; this.conversationId = cid; this.changed(cid);
          runId = response.runId;
          if (!runId) {
            const detail = await this.request<{ runs: AgentRun[] }>(`/api/conversations/${cid}`, { signal });
            runId = detail.runs.filter((r) => r.agent !== 'gemini').at(-1)?.id;
            if (!runId) throw new Error('Jarvis did not return an agent run.');
            this.onRun?.(runId);
            const run = detail.runs.find((r) => r.id === runId); if (run) finish(run);
          }
          else this.onRun?.(runId);
          if (seen.has(runId)) finish(seen.get(runId)!);
          await reconcile();
        } catch (error) { if (!done) { done = true; cleanup(); reject(error); } }
      })();
    });
  }
  dispose() { for (const cancel of this.pending) cancel(); }
}
