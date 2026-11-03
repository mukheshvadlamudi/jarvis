import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunner, NormalizedEvent, RunEventSink, RunHandle, RunInput, RunResult } from './types.ts';
import { emptyUsage } from './types.ts';
import { classifyToolCall } from '../approvals/policy.ts';

type Step =
  | { do: 'emit'; event: NormalizedEvent }
  | { do: 'tool'; tool: string; input: Record<string, unknown>; output: string; isError?: boolean }
  | { do: 'approval'; tool: string; input: Record<string, unknown>; kind: string; summary: string; reason: string }
  | { do: 'wait_followup' }
  | { do: 'file'; path: string; content: string }
  | { do: 'fail'; message: string };

export type MockScenario = 'success' | 'approval' | 'fail' | 'long' | 'tools' | 'limit';

export function pickScenario(prompt: string): MockScenario | 'learn' | 'cron' | 'consult' {
  if (prompt.includes('[jarvis:learn]')) return 'learn';
  if (prompt.includes('[jarvis:cron]')) return 'cron';
  if (prompt.includes('[jarvis:consult]')) return 'consult';
  const m = /\[mock:(success|approval|fail|long|tools|limit)\]/.exec(prompt);
  if (m) return m[1] as MockScenario;
  return 'success';
}

function seeded(text: string): () => number {
  let h = createHash('sha1').update(text).digest().readUInt32BE(0);
  return () => {
    h = (h * 1664525 + 1013904223) >>> 0;
    return h / 2 ** 32;
  };
}

const msg = (text: string): Step => ({ do: 'emit', event: { kind: 'message', payload: { role: 'assistant', text } } });

function firstLine(prompt: string): string {
  const line = prompt.replace(/\[mock:[a-z]+\]/g, '').trim().split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

const LEARNED_SKILL = {
  skill: {
    name: 'flaky-test-triage',
    description: 'Find and fix flaky tests: reproduce with repeats, pin time and randomness, then fix the root cause.',
    body: '# Flaky test triage\n\n1. Reproduce: run the test 30× (`npx vitest run <file> --repeat 30`).\n2. Pin time (fake timers, fixed TZ=UTC) and seeds; re-run.\n3. Look for shared state between tests and missing awaits.\n4. Fix the cause, not the symptom — no retries or longer timeouts.\n5. Add a regression note to the test explaining the cause.\n',
    updates: null,
  },
};

function stepsFor(input: RunInput, scenario: MockScenario | 'learn' | 'cron' | 'consult'): Step[] {
  if (scenario === 'consult') return [{ do: 'tool', tool: 'Read', input: { file_path: 'src/auth/session.ts' }, output: '140 lines' }];
  if (scenario === 'learn') return [msg(JSON.stringify(LEARNED_SKILL))];
  if (scenario === 'cron') return [];
  const title = firstLine(input.prompt) || 'the task';
  const rnd = seeded(input.taskId + input.prompt);
  const steps: Step[] = [];
  steps.push({ do: 'emit', event: { kind: 'status', payload: { status: 'started', detail: `Working in ${input.cwd}` } } });

  if (scenario === 'limit') {
    steps.push(msg(`Starting on: ${title}`));
    steps.push({ do: 'file', path: 'notes.md', content: '# Half done\n' });
    steps.push({ do: 'emit', event: { kind: 'file_change', payload: { path: 'notes.md', kind: 'add', additions: 1, deletions: 0 } } });
    steps.push(msg('Drafted the first half in notes.md.'));
    steps.push({ do: 'fail', message: "You've hit your usage limit. Try again at 4:30 PM." });
    return steps;
  }
  if (scenario === 'fail') {
    steps.push(msg(`Starting on: ${title}`));
    steps.push({ do: 'tool', tool: 'Bash', input: { command: 'npm test' }, output: 'Error: Cannot find module "./config"\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)', isError: true });
    steps.push({ do: 'fail', message: 'Test suite could not start: missing module ./config' });
    return steps;
  }

  if (scenario === 'approval') {
    steps.push(msg(`I'll prepare the change for "${title}" and then ask before anything leaves this machine.`));
    steps.push({ do: 'tool', tool: 'Bash', input: { command: 'git status --short' }, output: ' M src/auth/session.ts\n M test/session.test.ts' });
    steps.push({ do: 'tool', tool: 'Bash', input: { command: 'npm test -- session' }, output: ' ✓ test/session.test.ts (9 tests) 412ms\n\n Test Files  1 passed (1)\n      Tests  9 passed (9)' });
    steps.push({
      do: 'approval',
      tool: 'Bash',
      input: { command: `git push -u origin jarvis/${input.taskId}` },
      kind: 'git_push',
      summary: `Push jarvis/${input.taskId} to origin`,
      reason: 'Tests pass locally; pushing so a PR can be opened.',
    });
    steps.push(msg('Branch pushed. Ready for review.'));
    return steps;
  }

  if (scenario === 'long') {
    steps.push(msg(`Starting a long session for "${title}". Send a follow-up any time.`));
    steps.push({ do: 'tool', tool: 'Bash', input: { command: 'npm run build' }, output: 'vite v5 building for production…\n✓ 412 modules transformed.' });
    steps.push({ do: 'wait_followup' });
    steps.push(msg('Follow-up handled. Wrapping up.'));
    return steps;
  }

  const n = scenario === 'tools' ? 10 : 0;
  switch (input.taskType) {
    case 'code': {
      steps.push(msg(`Looking at the code for: ${title}`));
      steps.push({ do: 'tool', tool: 'Grep', input: { pattern: 'refreshToken', path: 'src' }, output: 'src/auth/session.ts:42:  const refreshToken = await store.get(userId);\nsrc/auth/session.ts:88:  if (!refreshToken) return null;' });
      steps.push({ do: 'tool', tool: 'Read', input: { file_path: 'src/auth/session.ts' }, output: '/* 140 lines */' });
      steps.push(msg('The refresh path reads the token before the previous write has settled. Adding a per-user lock.'));
      {
        // Demo of a mid-task consult (the real flow goes through the consult_agent MCP tool).
        const from = input.agent ?? 'claude';
        const to = from === 'claude' ? 'codex' : 'claude';
        const question = 'Is a per-user lock around the refresh enough, or do we also need a token version check?';
        steps.push({ do: 'emit', event: { kind: 'status', payload: { status: 'consult', phase: 'asked', from, to, question } } });
        steps.push({ do: 'emit', event: { kind: 'status', payload: { status: 'consult', phase: 'answered', from, to, question, answer: 'The lock is enough for a single instance. Release it in a finally block so a thrown rotate() cannot wedge the user, and add a test for two concurrent refreshes.' } } });
      }
      steps.push({ do: 'tool', tool: 'Edit', input: { file_path: 'src/auth/session.ts', old_string: 'const refreshToken', new_string: 'const refreshToken = await withLock(userId, () =>' }, output: 'Applied edit to src/auth/session.ts' });
      steps.push({ do: 'emit', event: { kind: 'file_change', payload: { path: 'src/auth/session.ts', kind: 'update', additions: 18, deletions: 4 } } });
      steps.push({ do: 'emit', event: { kind: 'file_change', payload: { path: 'test/session.test.ts', kind: 'update', additions: 31, deletions: 0 } } });
      steps.push({ do: 'tool', tool: 'Bash', input: { command: 'npm test' }, output: ' Test Files  14 passed (14)\n      Tests  128 passed (128)\n   Duration  6.21s' });
      break;
    }
    case 'research': {
      steps.push(msg(`Researching: ${title}`));
      for (const q of ['overview and current options', 'independent comparisons 2026', 'pricing and limits']) {
        steps.push({ do: 'tool', tool: 'web_search', input: { query: `${title} ${q}` }, output: `8 results for "${title} ${q}"` });
      }
      steps.push({ do: 'tool', tool: 'WebFetch', input: { url: 'https://example.org/comparison' }, output: 'Fetched 14,212 characters' });
      steps.push(msg('Writing the report with a Sources section.'));
      steps.push({ do: 'file', path: 'report.md', content: mockReport(title) });
      steps.push({ do: 'emit', event: { kind: 'file_change', payload: { path: 'report.md', kind: 'add', additions: 24, deletions: 0 } } });
      break;
    }
    case 'admin': {
      steps.push(msg(`Handling: ${title}`));
      steps.push({ do: 'tool', tool: 'mcp__gmail__search_threads', input: { query: 'is:unread newer_than:2d' }, output: '12 threads (3 from VIPs)' });
      steps.push({ do: 'tool', tool: 'mcp__gmail__get_thread', input: { id: '18f2c9a1b7' }, output: 'Thread: "Invoice #1042 — October" (2 messages)' });
      steps.push(msg('Drafted a reply and left it in Drafts — nothing was sent.'));
      break;
    }
    case 'write': {
      steps.push(msg(`Drafting: ${title}`));
      steps.push({ do: 'tool', tool: 'mcp__jarvis__search_memory', input: { query: title.split(' ').slice(0, 4).join(' ') }, output: '3 notes matched' });
      steps.push({ do: 'tool', tool: 'Write', input: { file_path: 'draft.md' }, output: 'Wrote 1,240 words to draft.md' });
      steps.push({ do: 'file', path: 'draft.md', content: `# ${title}\n\n**Summary:** traffic up 18% month on month, driven by the winter collection preview; newsletter sign-ups doubled after the pop-up form change.\n\n## Highlights\n- 4,812 visits (+18%), 61% mobile\n- Top product: Oak Sideboard (412 views)\n- 96 new newsletter subscribers\n\n## Next month\n1. Launch the winter collection page on 15 Nov.\n2. Add the size guide to product pages.\n` });
      steps.push({ do: 'file', path: 'traffic.csv', content: 'week,visits,signups\n2026-W40,1082,18\n2026-W41,1164,21\n2026-W42,1249,27\n2026-W43,1317,30\n' });
      steps.push({ do: 'emit', event: { kind: 'file_change', payload: { path: 'draft.md', kind: 'add', additions: 92, deletions: 0 } } });
      break;
    }
    default: {
      steps.push(msg(`Working on: ${title}`));
      steps.push({ do: 'tool', tool: 'mcp__jarvis__search_memory', input: { query: title.split(' ').slice(0, 4).join(' ') }, output: '2 notes matched' });
      steps.push({ do: 'tool', tool: 'mcp__jarvis__read_note', input: { path: 'Inbox.md' }, output: '18 lines' });
    }
  }
  for (let i = 0; i < n; i++) {
    steps.push({ do: 'tool', tool: 'Bash', input: { command: `rg -n "TODO" src/module${i}.ts` }, output: `${Math.floor(rnd() * 5)} matches` });
  }
  return steps;
}

function mockReport(title: string): string {
  const day = new Date().toISOString().slice(0, 10);
  if (!/backup|postgres/i.test(title)) {
    return `# ${title}

**Answer:** the two strongest options are close; pick the first unless cost is the deciding factor.

## Findings
- Option A is the most mature and best documented.
- Option B is cheaper and simpler, with fewer integrations.
- Everything else surveyed was either abandoned or aimed at much larger teams.

## Sources
- Official documentation for each option (accessed ${day})
- Two independent comparison articles from the last 12 months (accessed ${day})
`;
  }
  return `# ${title}

**Recommendation:** pgBackRest for a small VPS — incremental backups, parallel restore, S3-compatible storage, and a predictable ~50 MB memory footprint.

## Options compared
| Tool | Strength | Watch out for |
|---|---|---|
| pgBackRest | Fast parallel restore, retention policies | More config than the others |
| WAL-G | Simple, cloud-native, low RAM | Fewer verification tools |
| Barman | Mature, good docs | Wants a separate backup server |
| Provider snapshots | Zero setup | Coarse restore points, vendor lock-in |

## Notes
- Test a restore monthly; a backup you have not restored is a hope, not a backup.
- Keep 7 daily and 4 weekly full backups; WAL archiving gives point-in-time recovery between them.

## Sources
- pgBackRest user guide — pgbackrest.org/user-guide.html (accessed ${new Date().toISOString().slice(0, 10)})
- WAL-G documentation — github.com/wal-g/wal-g (accessed ${new Date().toISOString().slice(0, 10)})
- Barman documentation — docs.pgbarman.org (accessed ${new Date().toISOString().slice(0, 10)})
`;
}

function summaryFor(input: RunInput, toolCalls: number): string {
  const title = firstLine(input.prompt);
  switch (input.taskType) {
    case 'code':
      return `Fixed: ${title}. Added a per-user lock around token refresh; 2 files changed (+49 −4), 128 tests pass.`;
    case 'research':
      return `Report ready for "${title}": compared 5 options, recommendation and sources included.`;
    case 'admin':
      return `Triaged for "${title}": 12 threads checked, 1 reply drafted (not sent).`;
    case 'write':
      return `Draft written for "${title}" (1,240 words) — saved as draft.md.`;
    default:
      return `Done: ${title} (${toolCalls} tool calls).`;
  }
}

/** A plausible conversational answer for the demo (chat runs). */
function chatAnswer(input: RunInput): string {
  const asked = input.prompt.split('New message from the owner:').pop()!.replace(/\[mock:[a-z]+\]/g, '').trim().split('\n')[0] ?? '';
  const files = input.attachments?.length ? `\n\nI read the file you attached (${input.attachments.map((a) => a.name).join(', ')}) for this.` : '';
  if (/\?$/.test(asked) || /^(what|how|why|which|should|can|is|are|do|does)\b/i.test(asked)) {
    return `Short answer: **yes, with one caveat**.\n\n- Your notes already cover most of it (see *Projects/ClientEasy*).\n- The open risk is the token refresh race; a per-user lock fixes it.\n- If you want, I can turn this into a task and open a PR.${files}`;
  }
  return `Done. Here is what I found for “${asked.slice(0, 80)}”:\n\n1. Checked your notes and the last two related tasks.\n2. Nothing blocks it; the only decision left is the release date.\n3. Suggested next step: draft the email and I will wait for your OK before sending.${files}`;
}

export interface MockRunnerOptions {
  delayMs: number;
}

/** Deterministic scripted runner for tests, cloud builds and the demo UI. Never calls a model. */
export function createMockRunner(opts: MockRunnerOptions): AgentRunner {
  return {
    id: 'mock',
    start(input: RunInput, sink: RunEventSink): RunHandle {
      const scenario = pickScenario(input.prompt);
      const steps = stepsFor(input, scenario);
      const abort = new AbortController();
      const followUps: string[] = [];
      let wakeFollowUp: (() => void) | null = null;
      const sessionId = input.resumeSessionId ?? `mock-${input.taskId}-${createHash('sha1').update(input.runId).digest('hex').slice(0, 8)}`;
      const usage = emptyUsage();
      let toolCalls = 0;

      const sleep = (ms: number) =>
        new Promise<void>((resolve, reject) => {
          if (abort.signal.aborted) return reject(new Error('cancelled'));
          const t = setTimeout(resolve, ms);
          abort.signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('cancelled'));
          }, { once: true });
        });

      const done = (async (): Promise<RunResult> => {
        sink.setSessionId(sessionId);
        if (input.resumeSessionId) {
          sink.emit({ kind: 'status', payload: { status: 'resumed', detail: `Resumed session ${sessionId}` } });
        }
        const chat = input.webSearch === true && scenario !== 'learn' && scenario !== 'cron' && scenario !== 'consult';
        const stream = async (kind: 'text' | 'thinking', text: string) => {
          const words = text.split(/(?<= )/);
          const size = Math.max(1, Math.ceil(words.length / 6));
          for (let i = 0; i < words.length; i += size) {
            sink.live?.({ kind, text: words.slice(i, i + size).join('') });
            await sleep(Math.max(1, Math.round(opts.delayMs / 4)));
          }
        };
        try {
          if (chat) {
            sink.live?.({ kind: 'reset' });
            const thought = `The owner asks about "${firstLine(input.prompt).slice(0, 80)}". Check their notes for context first, then answer briefly and offer a next step.`;
            await stream('thinking', thought);
            sink.emit({ kind: 'message', payload: { role: 'reasoning', text: thought } });
          }
          for (const step of steps) {
            await sleep(opts.delayMs);
            usage.inputTokens += 1800;
            usage.outputTokens += 140;
            usage.cachedTokens += 1200;
            if (step.do === 'emit') sink.emit(step.event);
            else if (step.do === 'tool') {
              toolCalls++;
              const id = `toolu_${toolCalls}`;
              const verdict = classifyToolCall({ tool: step.tool, input: step.input, cwd: input.cwd, vault: input.vaultPath });
              sink.emit({ kind: 'tool_call', payload: { id, tool: step.tool, input: step.input, risk: verdict.level } });
              await sleep(opts.delayMs / 2);
              sink.emit({ kind: 'tool_result', payload: { id, tool: step.tool, output: step.output, isError: step.isError ?? false } });
            } else if (step.do === 'approval') {
              toolCalls++;
              const id = `toolu_${toolCalls}`;
              sink.emit({ kind: 'tool_call', payload: { id, tool: step.tool, input: step.input, risk: 'ask' } });
              const decision = await Promise.race([
                sink.requestApproval({ kind: step.kind, summary: step.summary, reason: step.reason, detail: { tool: step.tool, input: step.input } }),
                new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
              ]);
              if (!decision.approved) {
                sink.emit({ kind: 'tool_result', payload: { id, tool: step.tool, output: `Denied by owner${decision.note ? `: ${decision.note}` : ''}`, isError: true } });
                sink.emit({ kind: 'message', payload: { role: 'assistant', text: 'Understood — I did not push. The branch is ready locally if you change your mind.' } });
                return { status: 'done', summary: `Prepared locally; push was ${decision.status} by you.`, sessionId, usage, toolCalls };
              }
              sink.emit({ kind: 'tool_result', payload: { id, tool: step.tool, output: `To github.com:owner/repo.git\n * [new branch]      jarvis/${input.taskId} -> jarvis/${input.taskId}` } });
            } else if (step.do === 'wait_followup') {
              while (followUps.length === 0) {
                await Promise.race([
                  new Promise<void>((r) => (wakeFollowUp = r)),
                  new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
                ]);
              }
              const text = followUps.shift()!;
              sink.emit({ kind: 'message', payload: { role: 'assistant', text: `Got it: "${text}". Applying that now.` } });
            } else if (step.do === 'file') {
              try {
                writeFileSync(join(input.cwd, step.path), step.content);
              } catch {
                // read-only or missing folder: the transcript still shows the change
              }
            } else if (step.do === 'fail') {
              sink.emit({ kind: 'error', payload: { message: step.message } });
              return { status: 'failed', summary: step.message, error: step.message, sessionId, usage, toolCalls };
            }
            while (followUps.length && scenario !== 'long') {
              const text = followUps.shift()!;
              sink.emit({ kind: 'message', payload: { role: 'assistant', text: `Noted: "${text}". I'll fold that in.` } });
            }
          }
          const summary = scenario === 'learn' ? JSON.stringify(LEARNED_SKILL) : scenario === 'cron' ? '0 9 * * 1' : scenario === 'consult' ? 'Agree with the per-user lock. One gap: release the lock in a finally block so a thrown rotate() cannot wedge the user. Add a test for two concurrent refreshes.' : chat ? chatAnswer(input) : summaryFor(input, toolCalls);
          if (chat) {
            sink.live?.({ kind: 'reset' });
            await stream('text', summary);
          }
          if (scenario !== 'learn' && scenario !== 'cron' && scenario !== 'consult') sink.emit({ kind: 'message', payload: { role: 'assistant', text: summary } });
          usage.costUsd = Math.round(((usage.inputTokens * 3 + usage.outputTokens * 15) / 1e6) * 10000) / 10000;
          sink.emit({ kind: 'usage', payload: { ...usage } });
          return { status: 'done', summary, sessionId, usage, toolCalls };
        } catch (err) {
          if (abort.signal.aborted) return { status: 'cancelled', summary: 'Cancelled by you.', sessionId, usage, toolCalls };
          const message = err instanceof Error ? err.message : String(err);
          return { status: 'failed', summary: message, error: message, sessionId, usage, toolCalls };
        }
      })();

      return {
        done,
        async cancel() {
          abort.abort();
        },
        async sendFollowUp(text: string) {
          followUps.push(text);
          sink.emit({ kind: 'message', payload: { role: 'user', text } });
          wakeFollowUp?.();
        },
      };
    },
  };
}
