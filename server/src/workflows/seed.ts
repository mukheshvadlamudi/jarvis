import type { Services } from '../app.ts';
import { run } from '../db/index.ts';
import { builtins } from './builtins.ts';
import type { StepResult } from './model.ts';

export function seedWorkflows(s: Services, now: number) {
  for (const waiting of [false,true]) {
    const d = builtins[waiting ? 1 : 0]; const cid = waiting ? 't_workflow_waiting' : 't_workflow_done'; const wid = waiting ? 'wf_demo_waiting' : 'wf_demo_done';
    const input = waiting ? 'Fix the ClientEasy token refresh race' : 'Compare Postgres backup options';
    const task = s.tasks.create({ title: `${d.name}: ${input}`, body: input, type: 'other', mode: 'chat', run: false, project_id: null });
    // Stable conversation ids let screenshot and documentation links target the same examples.
    run(s.db, 'UPDATE tasks SET id = ? WHERE id = ?', cid, task.id);
    const at = new Date(now - (waiting ? 30 : 90) * 60_000).toISOString();
    const results: Record<string, StepResult> = {};
    for (const step of d.steps) {
      if (waiting && ['publish','summary'].includes(step.id)) continue;
      if (waiting && ['revise','rereview'].includes(step.id)) { results[step.id] = { state: 'skipped', answer: '', files: [], attempts: 0 }; continue; }
      const answer = step.id === 'implement' ? 'Added a per-user lock around token refresh. Concurrent requests now share one rotation. All 128 tests pass.' : step.id === 'review' ? 'APPROVE — The lock covers the race and releases on failure. Parallel-request tests cover both paths.' : step.id === 'summary' ? 'pgBackRest is the best fit for this setup. Claude checked the retention and restore claims against the primary documentation. Test a restore before switching production backups. Full report in the conversation' : 'Compared pgBackRest, WAL-G and Barman using primary documentation. The complete report includes retention, restore and storage tradeoffs.';
      results[step.id] = { state: 'done', answer, files: step.id === 'research' ? ['report.md'] : [], attempts: 1 };
      if (step.kind === 'approval') {
        const a = s.approvals.create({ runId: null, taskId: cid, kind: 'request', summary: step.summary, detail: { action: 'workflow', workflowRunId: wid, agent: 'claude' } });
        results[step.id] = { state: 'waiting_approval', approvalId: a.id, answer: '', files: [], attempts: 1 }; break;
      }
      if ('agent' in step) {
        const rid = `${wid}_${step.id}`;
        run(s.db, "INSERT INTO runs (id, task_id, agent, cwd, started_at, ended_at, status, purpose, visibility, answer, route_reason, prompt) VALUES (?, ?, ?, ?, ?, ?, 'done', 'workflow_step', 'conversation', ?, ?, ?)", rid, cid, step.agent === 'auto' ? 'claude' : step.agent, s.env.dataDir, at, at, answer, `workflow: ${step.id === 'research' ? 'Research sources' : step.id === 'review' ? 'Independent review' : step.id === 'implement' ? 'Implement and test' : 'Spoken summary'}`, step.prompt);
        results[step.id].runId = rid; results[step.id].agent = step.agent;
        run(s.db, "INSERT INTO run_events (run_id, ts, kind, payload_json) VALUES (?, ?, 'message', ?)", rid, at, JSON.stringify({ role: 'assistant', text: answer }));
      }
    }
    run(s.db, 'UPDATE tasks SET status = ?, updated_at = ?, agent = ? WHERE id = ?', waiting ? 'needs_you' : 'done', at, 'claude', cid);
    run(s.db, 'INSERT INTO workflow_runs (id, workflow_id, conversation_id, status, current_step, step_results_json, started_at, ended_at, definition_json, input) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', wid, d.id, cid, waiting ? 'waiting_approval' : 'done', waiting ? 4 : d.steps.length, JSON.stringify(results), at, waiting ? null : at, JSON.stringify(d), input);
  }
}
