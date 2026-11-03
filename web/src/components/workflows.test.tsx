import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkflowProgress } from './Workflows.tsx';
import type { RunDetail, Workflow } from '../lib/workflows.ts';
import { shortcut } from '../lib/workflows.ts';

const definition: Workflow = { id: 'ship-a-fix', name: 'Ship a fix', builtIn: true, description: 'Implement and review', input: { label: 'Fix', required: true }, triggers: ['/fix'], steps: [
  { id: 'implement', kind: 'agent', agent: 'claude', mode: 'write', prompt: '{{input}}' },
  { id: 'review', kind: 'agent', agent: 'codex', mode: 'read-only', prompt: '{{steps.implement.answer}}' },
  { id: 'approval', kind: 'approval', summary: 'Push branch and open a PR?' },
  { id: 'summary', kind: 'summary', agent: 'claude', prompt: 'Summarize' },
] };
const run: RunDetail = { id: 'wf', workflow_id: definition.id, conversation_id: 'chat', status: 'waiting_approval', current_step: 2, step_results_json: '{}', definition_json: '{}', input: 'Fix auth', started_at: new Date().toISOString(), ended_at: null, error: null, summary: '', definition, results: {
  implement: { state: 'done', answer: 'Done', files: [], attempts: 1, agent: 'claude' },
  review: { state: 'running', answer: '', files: [], attempts: 1, agent: 'codex' },
  approval: { state: 'waiting_approval', approvalId: 'approval', answer: '', files: [], attempts: 1 },
} };
describe('workflow progress', () => {
  it('renders each step state, agents, approval and cancellation', () => {
    const html = renderToStaticMarkup(<WorkflowProgress run={run} approvals={[{ id: 'approval', run_id: null, task_id: 'chat', kind: 'request', summary: 'Push branch and open a PR?', status: 'pending', created_at: run.started_at, decided_at: null, decided_via: null, note: null, detail: {} }]} />);
    for (const text of ['Workflow progress','Ship a fix','Done','Running','Queued','Waiting for you','claude','codex','Approve','Reject','Cancel workflow']) expect(html).toContain(text);
    expect(html).toContain('spinner');
  });
  it('shows errors and no cancellation on finished runs', () => {
    const html = renderToStaticMarkup(<WorkflowProgress run={{ ...run, status: 'failed', error: 'Test suite failed', results: { implement: { ...run.results.implement, state: 'failed' } } }} />);
    expect(html).toContain('Failed'); expect(html).toContain('Test suite failed'); expect(html).not.toContain('Cancel workflow');
  });
  it('maps slash triggers and preserves multiline input', () => {
    expect(shortcut('/fix Fix auth\nAdd tests', [definition])).toMatchObject({ input: 'Fix auth\nAdd tests', definition });
    expect(shortcut('/unknown', [definition])).toBeNull(); expect(shortcut('Fix auth', [definition])).toBeNull();
  });
});
