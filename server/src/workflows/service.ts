import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Services } from '../app.ts';
import { all, get, run } from '../db/index.ts';
import { agentsOf } from '../agents/service.ts';
import { memoryOf } from '../memory/module.ts';
import { LIMIT_ERROR } from '../tasks/orchestrator.ts';
import { canTransition } from '../tasks/stateMachine.ts';
import type { Approval, Run, UsageState, UsageWindow } from '../types.ts';
import { newId, nowIso } from '../util/ids.ts';
import { builtins } from './builtins.ts';
import { matches, render, validate } from './model.ts';
import type { Definition, RunDetail, StepResult, WorkflowRun } from './model.ts';

export class Workflows {
  private s: Services;
  private dir: string;
  private busy = new Set<string>();
  private closed = false;
  readonly loadErrors: string[] = [];
  private users = new Map<string, Definition>();
  constructor(s: Services) {
    this.s = s; this.dir = join(s.env.dataDir, 'workflows'); mkdirSync(this.dir, { recursive: true });
    for (const file of readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
      try { const d = validate(JSON.parse(readFileSync(join(this.dir, file), 'utf8'))); if (builtins.some(b => b.id === d.id)) throw new Error('Built-in ids are reserved'); if (file !== `${d.id}.json`) throw new Error('Filename must match the workflow id'); this.users.set(d.id, d); }
      catch (error) { this.loadErrors.push(`${file}: ${(error as Error).message}`); }
    }
    s.approvals.actions.set('workflow', a => this.approvalChanged(a));
    s.approvals.actions.set('workflow_agent', a => this.agentApprovalChanged(a));
    const off = s.bus.subscribe(e => {
      if (e.type === 'run.started') {
        const agentRun = e.data as Run;
        if (agentRun.purpose !== 'workflow_step') return;
        const w = this.active(agentRun.task_id); if (!w) return;
        const result = w.results[w.definition.steps[w.current_step]?.id];
        if (result) { result.runId = agentRun.id; result.agent = agentRun.agent; this.save(w); }
      }
      if (e.type === 'run.finished') {
        const agentRun = e.data as Run;
        if (agentRun.purpose === 'workflow_step') setImmediate(() => { if (!this.closed) void this.finished(agentRun); });
      }
      if (e.type === 'task.updated' && (e.data as { status: string }).status === 'cancelled') {
        const w = this.active((e.data as { id: string }).id); if (w) this.end(w, 'cancelled', 'Stopped by owner');
      }
      if (e.type === 'approval.created') {
        const a = e.data as Approval; const w = a.task_id ? this.active(a.task_id) : undefined;
        const result = w?.results[w.definition.steps[w.current_step]?.id];
        if (w && a.run_id && result?.runId === a.run_id) {
          const detail = JSON.parse(a.detail_json);
          if (!detail.action) { a.detail_json = JSON.stringify({ ...detail, action: 'workflow_agent', workflowRunId: w.id }); run(s.db, 'UPDATE approvals SET detail_json = ? WHERE id = ?', a.detail_json, a.id); }
          result.state = 'waiting_approval'; result.approvalId = a.id; result.answer = a.summary; w.status = 'waiting_approval'; this.save(w);
        }
      }
      if (e.type === 'approval.updated') {
        const a = e.data as Approval;
        if (a.run_id) this.agentApprovalChanged(a);
        // Expiration has no action callback in the approvals service.
        if (a.status === 'expired') this.approvalChanged(a);
      }
    });
    s.closers.push(() => { this.closed = true; off(); s.approvals.actions.delete('workflow'); s.approvals.actions.delete('workflow_agent'); });
  }
  list() { return [...builtins.map(d => ({ ...d, builtIn: true })), ...[...this.users.values()].map(d => ({ ...d, builtIn: false }))]; }
  find(id: string) { const key = id.trim().toLowerCase(); return this.list().find(d => d.id === key || d.name.toLowerCase() === key || d.triggers.some(t => t.toLowerCase() === key)); }
  put(value: unknown) {
    const d = validate(value);
    if (builtins.some(b => b.id === d.id)) throw new Error('Duplicate a built-in before editing it');
    for (const other of this.list().filter(w => w.id !== d.id)) {
      if (other.name.toLowerCase() === d.name.toLowerCase()) throw new Error(`A workflow named ${other.name} already exists`);
      const collision = d.triggers.find(t => other.triggers.some(o => o.toLowerCase() === t.toLowerCase()));
      if (collision) throw new Error(`Trigger ${collision} is already used by ${other.name}`);
    }
    const file = join(this.dir, `${d.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(d, null, 2)); renameSync(`${file}.tmp`, file);
    this.users.set(d.id, d); this.s.bus.publish('workflow.updated', { definitionId: d.id }); return d;
  }
  delete(id: string) {
    if (builtins.some(d => d.id === id)) throw new Error('Built-in workflows cannot be deleted');
    if (!this.users.has(id)) throw new Error('No user workflow with that id');
    unlinkSync(join(this.dir, `${id}.json`)); this.users.delete(id); this.s.bus.publish('workflow.updated', { definitionId: id });
  }
  get(id: string): RunDetail | undefined {
    const row = get<WorkflowRun>(this.s.db, 'SELECT * FROM workflow_runs WHERE id = ?', id);
    if (!row) return;
    const definition = JSON.parse(row.definition_json) as Definition;
    const results = JSON.parse(row.step_results_json) as Record<string, StepResult>;
    const summary = definition.steps.filter(s => s.kind === 'summary').map(s => results[s.id]?.answer ?? '').filter(Boolean).at(-1) ?? '';
    return { ...row, definition, results, summary };
  }
  recent(conversationId?: string) { return all<{ id: string }>(this.s.db, `SELECT id FROM workflow_runs ${conversationId ? 'WHERE conversation_id = ?' : ''} ORDER BY started_at DESC, rowid DESC LIMIT 50`, ...(conversationId ? [conversationId] : [])).map(r => this.get(r.id)!); }
  private active(cid: string) { const row = get<{ id: string }>(this.s.db, "SELECT id FROM workflow_runs WHERE conversation_id = ? AND status IN ('running','waiting_approval')", cid); return row ? this.get(row.id) : undefined; }
  async start(id: string, input: unknown, conversationId?: string) {
    const d = this.find(id); if (!d) throw new Error('No workflow with that id or name');
    if (input !== undefined && typeof input !== 'string') throw new Error('Input must be text');
    const text = (input as string | undefined ?? '').trim();
    if (text.length > 20000) throw new Error('Input must be at most 20000 characters');
    if (d.input.required && !text) throw new Error(d.input.label);
    const existing = conversationId ? this.s.tasks.get(conversationId) : undefined;
    if (conversationId && (!existing || existing.mode !== 'chat')) throw new Error('Choose an existing Ask conversation');
    if (conversationId && (this.active(conversationId) || this.s.orchestrator.isActive(conversationId))) throw new Error('This conversation is still working; stop it or wait');
    const classification = this.s.tasks.preview(text);
    const project = this.s.tasks.projects().find(p => p.id === classification.projectId && p.kind === 'code' && p.path);
    if (d.id === 'ship-a-fix' && !project && this.s.env.runner !== 'mock') throw new Error('Name a registered code project with a local folder in the fix request');
    const code = d.id === 'ship-a-fix' || (classification.type === 'code' && !!project && d.steps.some(step => step.kind === 'agent' && step.mode === 'write'));
    const type = code ? 'code' : d.id === 'research-and-verify' ? 'research' : 'other';
    const t = existing ?? this.s.tasks.create({ title: `${d.name}${text ? `: ${text}` : ''}`, body: text, mode: 'chat', type, run: false, project_id: code ? project?.id ?? null : null });
    if (existing) this.s.tasks.patch(t.id, { type, project_id: code ? project?.id ?? null : null });
    const definition: Definition = validate(Object.fromEntries(Object.entries(d).filter(([k]) => k !== 'builtIn')));
    const wid = newId('wf');
    run(this.s.db, "INSERT INTO workflow_runs (id, workflow_id, conversation_id, status, started_at, definition_json, input) VALUES (?, ?, ?, 'running', ?, ?, ?)", wid, d.id, t.id, nowIso(), JSON.stringify(definition), text);
    this.save(this.get(wid)!);
    setImmediate(() => { if (!this.closed) void this.advance(wid); });
    return { workflowRunId: wid, conversationId: t.id };
  }
  private save(w: RunDetail) {
    run(this.s.db, 'UPDATE workflow_runs SET status = ?, current_step = ?, step_results_json = ?, ended_at = ?, error = ? WHERE id = ?', w.status, w.current_step, JSON.stringify(w.results), w.ended_at, w.error, w.id);
    this.s.bus.publish('workflow.updated', { ...w, summary: this.get(w.id)?.summary });
  }
  private end(w: RunDetail, status: 'done' | 'failed' | 'cancelled', error: string | null = null) {
    w.status = status; w.ended_at = nowIso(); w.error = error; this.save(w);
    const t = this.s.tasks.get(w.conversation_id);
    if (t && !canTransition(t.status, status)) { this.s.tasks.setStatus(t.id, 'queued'); this.s.tasks.setStatus(t.id, 'running'); }
    this.s.tasks.setStatus(w.conversation_id, status, { result_summary: error ?? this.get(w.id)?.summary ?? 'Workflow finished' });
  }
  async cancel(id: string) {
    const w = this.get(id); if (!w) throw new Error('No workflow run with that id');
    if (!['running','waiting_approval'].includes(w.status)) return w;
    this.end(w, 'cancelled', 'Stopped by owner');
    for (const result of Object.values(w.results)) if (result.approvalId && this.s.approvals.get(result.approvalId)?.status === 'pending') this.s.approvals.decide(result.approvalId, 'rejected', 'Workflow cancelled', 'cancel');
    await this.s.orchestrator.cancel(w.conversation_id); return this.get(id)!;
  }
  private approvalChanged(a: Approval) {
    let id: unknown; try { id = JSON.parse(a.detail_json).workflowRunId; } catch { return; }
    if (typeof id !== 'string') return;
    const w = this.get(id); if (!w || w.status !== 'waiting_approval' || a.status === 'pending') return;
    const result = w.results[w.definition.steps[w.current_step].id];
    if (result?.approvalId !== a.id) return;
    result.state = a.status === 'approved' ? 'done' : 'failed'; result.answer = a.status;
    if (a.status !== 'approved') { this.end(w, 'cancelled', a.status === 'expired' ? 'Approval expired; nothing was published' : 'Approval rejected; nothing was published'); return; }
    w.current_step++; w.status = 'running'; this.save(w); void this.advance(w.id);
  }
  private agentApprovalChanged(a: Approval) {
    const w = a.task_id ? this.active(a.task_id) : undefined;
    if (!w || !a.run_id || a.status === 'pending') return;
    const step = w.definition.steps[w.current_step]; const result = w.results[step.id];
    if (result?.approvalId !== a.id || result.runId !== a.run_id) return;
    if (a.status !== 'approved') { void this.cancel(w.id); return; }
    result.state = 'running'; w.status = 'running'; this.save(w);
    // Live approval callbacks continue the same agent. An orphan needs a new tracked step run.
    if (!this.s.orchestrator.isActive(w.conversation_id)) void this.advance(w.id);
  }
  private gather(sources: string[]) {
    return sources.map(source => {
      let data: unknown;
      if (source === 'usage') data = speakableUsage(this.s.usage.current());
      else if (source === 'agents') data = Object.values(agentsOf(this.s).status()).map((a) => ({ agent: a.label, state: a.state, detail: a.detail, working_on: a.busy.map((b) => b.title) }));
      else if (source === 'schedule') { const date = new Date().toLocaleDateString('en-CA'); data = { date, routines: all(this.s.db, "SELECT name, cron, next_run_at FROM schedules WHERE enabled = 1 AND date(next_run_at, 'localtime') = date('now', 'localtime')"), calendar: 'External calendar unavailable; these are Jarvis routines only' }; }
      else { const vault = memoryOf(this.s).vault; const hits = vault.search(source.slice(6), { limit: 5 }); data = hits.map(h => ({ path: h.path, note: vault.read(h.path) })); }
      return `${source}:\n${JSON.stringify(data).slice(0, 1400)}`;
    }).join('\n\n').slice(0, 6000);
  }
  private async advance(id: string) {
    if (this.closed || this.busy.has(id)) return;
    this.busy.add(id);
    try {
      const w = this.get(id); if (!w || w.status !== 'running') return;
      const task = this.s.tasks.get(w.conversation_id)!;
      if (!['running','needs_you'].includes(task.status)) { this.s.tasks.setStatus(task.id, 'queued'); this.s.tasks.setStatus(task.id, 'running'); }
      while (w.current_step < w.definition.steps.length) {
        const step = w.definition.steps[w.current_step];
        if (!matches(step.when, w.results)) { w.results[step.id] = { state: 'skipped', answer: '', files: [], attempts: 0 }; w.current_step++; this.save(w); continue; }
        const previous = w.results[step.id];
        const result: StepResult = { state: 'running', answer: '', files: [], attempts: (previous?.attempts ?? 0) + 1, handedOver: previous?.handedOver, agent: previous?.agent };
        w.results[step.id] = result; this.save(w);
        if (step.kind === 'gather') { result.answer = this.gather(step.sources); result.state = 'done'; w.current_step++; this.save(w); continue; }
        if (step.kind === 'approval') {
          // Publishing must never follow an unresolved change request in the built-in shipping graph.
          if (w.workflow_id === 'ship-a-fix') { const verdict = w.results.rereview?.state === 'done' ? w.results.rereview.answer : w.results.review?.answer ?? ''; if (!/^APPROVE\b/.test(verdict.trim())) { result.state = 'failed'; this.end(w, 'failed', 'Review did not approve the fix; inspect the review before publishing'); return; } }
          const a = this.s.approvals.create({ runId: null, taskId: w.conversation_id, kind: 'request', summary: render(step.summary, w.input, w.results), detail: { action: 'workflow', workflowRunId: w.id } });
          result.state = 'waiting_approval'; result.approvalId = a.id; w.status = 'waiting_approval'; this.save(w); this.s.tasks.setStatus(w.conversation_id, 'needs_you'); return;
        }
        const approved = previous?.approvalId ? this.s.approvals.get(previous.approvalId) : undefined;
        const prompt = `${result.handedOver ? 'The previous agent reached its plan limit. Continue the work already in this folder; inspect existing files before making changes.\n\n' : ''}${approved?.status === 'approved' ? `The owner approved this action: ${approved.summary}. Continue it using the approval-guarded tools.\n\n` : ''}${render(step.prompt, w.input, w.results)}`;
        const started = await this.s.orchestrator.ask(w.conversation_id, prompt, { purpose: 'workflow_step', sandbox: step.kind === 'agent' && step.mode === 'write' ? 'workspace-write' : 'read-only', agent: result.agent === 'codex' || result.agent === 'claude' ? result.agent : step.agent === 'auto' ? undefined : step.agent, effort: step.effort, model: step.kind === 'agent' && !result.handedOver ? step.model : undefined });
        const fresh = this.get(id)!;
        if (!['running','waiting_approval'].includes(fresh.status)) { await this.s.orchestrator.cancel(w.conversation_id); return; }
        if (!started.runId) throw new Error('The agent could not start; check the conversation and plan availability');
        fresh.results[step.id].runId = started.runId; this.save(fresh); return;
      }
      this.end(w, 'done');
    } catch (error) {
      const w = this.get(id);
      if (w && w.status === 'running') {
        const step = w.definition.steps[w.current_step]; const result = step ? w.results[step.id] : undefined;
        if (result) { result.state = 'failed'; result.answer = (error as Error).message; }
        if (result && result.attempts <= (step.retryOnFail ?? 1)) { this.save(w); setImmediate(() => { if (!this.closed) void this.advance(id); }); }
        else this.end(w, 'failed', (error as Error).message);
      }
    }
    finally { this.busy.delete(id); }
  }
  private async finished(agentRun: Run) {
    const w = this.active(agentRun.task_id); if (!w) return;
    const step = w.definition.steps[w.current_step]; const result = w.results[step.id];
    if (result?.runId !== agentRun.id) return;
    if (w.status === 'waiting_approval') {
      if (agentRun.status === 'cancelled') { this.end(w, 'cancelled', 'Agent stopped by owner'); return; }
      // Codex can return PENDING instead of holding an approval callback open.
      const approval = result.approvalId ? this.s.approvals.get(result.approvalId) : undefined;
      if (approval?.status === 'pending') return;
    }
    if (agentRun.status === 'cancelled') { result.state = 'failed'; this.end(w, 'cancelled', 'Agent stopped by owner'); return; }
    if (agentRun.status === 'failed') {
      result.state = 'failed'; result.answer = agentRun.error ?? 'Agent step failed';
      const limited = LIMIT_ERROR.test(result.answer);
      if (limited && (agentRun.agent === 'claude' || agentRun.agent === 'codex')) this.s.usage.recordReading({ agent: agentRun.agent, window: 'five_hour', usedPercent: 100, resetsAt: new Date(Date.now() + 3600_000).toISOString(), source: 'limit-hit' });
      if (limited && !result.handedOver && this.s.config.get().router.switchOnLimit !== false) {
        const to = agentRun.agent === 'claude' ? 'codex' : 'claude'; const usage = this.s.usage.current()[to];
        if (![usage.five_hour, usage.weekly].some(win => win && win.usedPercent >= this.s.config.get().router.fallbackAtPercent)) { result.agent = to; result.handedOver = true; this.save(w); await this.advance(w.id); return; }
      }
      this.save(w);
      if (!limited && result.attempts <= (step.retryOnFail ?? 1)) await this.advance(w.id);
      else this.end(w, 'failed', result.answer);
      return;
    }
    result.state = 'done'; result.answer = agentRun.answer ?? '';
    result.files = all<{ payload_json: string }>(this.s.db, "SELECT payload_json FROM run_events WHERE run_id = ? AND kind = 'file_change'", agentRun.id).map(e => JSON.parse(e.payload_json).path).filter((p): p is string => typeof p === 'string').slice(0, 100).map(p => resolve(agentRun.cwd, p));
    w.current_step++; this.save(w); await this.advance(w.id);
  }
  recover() {
    for (const row of all<{ id: string }>(this.s.db, "SELECT id FROM workflow_runs WHERE status IN ('running','waiting_approval')")) {
      const w = this.get(row.id)!;
      if (w.status === 'running') {
        const result = w.results[w.definition.steps[w.current_step]?.id];
        if (result?.state === 'running') { result.state = 'failed'; this.end(w, 'failed', 'Interrupted by a Jarvis restart. Completed steps are saved; start a new run to try again.'); }
        else void this.advance(w.id);
      } else if (w.status === 'waiting_approval') {
        const result = w.results[w.definition.steps[w.current_step]?.id]; const a = result?.approvalId ? this.s.approvals.get(result.approvalId) : undefined;
        if (!a) this.end(w, 'failed', 'Approval is missing; start a new workflow'); else if (a.status !== 'pending') { if (a.run_id) this.agentApprovalChanged(a); else this.approvalChanged(a); }
      }
    }
  }
}
export function workflowsOf(s: Services) { return s.modules.workflows as Workflows; }
export function setupWorkflows(s: Services) { const service = new Workflows(s); s.modules.workflows = service; s.starters.push(() => service.recover()); }

/** Plan usage the way a person says it: percentages and local reset times, no ISO timestamps. */
export function speakableUsage(u: UsageState, now = Date.now()): Record<string, Record<string, string>> {
  const fmt = (w: UsageWindow | null) => {
    if (!w) return 'not reported yet';
    if (!w.resetsAt) return `${Math.round(w.usedPercent)}% used`;
    const at = new Date(w.resetsAt);
    const mins = Math.max(0, Math.round((at.getTime() - now) / 60_000));
    const when = mins >= 36 * 60 ? at.toLocaleDateString(undefined, { weekday: 'long' }) : at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const inText = mins >= 120 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`;
    return `${Math.round(w.usedPercent)}% used, resets ${when} local time (in ${mins >= 36 * 60 ? `${Math.round(mins / 1440)} days` : inText})`;
  };
  return { Claude: { five_hour: fmt(u.claude.five_hour), weekly: fmt(u.claude.weekly) }, Codex: { five_hour: fmt(u.codex.five_hour), weekly: fmt(u.codex.weekly) } };
}
