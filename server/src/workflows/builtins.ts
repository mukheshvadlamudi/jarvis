import type { Definition } from './model.ts';

export const builtins: Definition[] = [
  { id: 'research-and-verify', name: 'Research and verify', description: 'Codex researches. Claude checks claims and sources. You get a short verdict and the full report.', triggers: ['/research', 'research and verify'], input: { label: 'What should we research?', required: true }, steps: [
    { id: 'research', kind: 'agent', agent: 'codex', mode: 'write', prompt: 'Research with web search: {{input}}\nSave a report as report.md in this scratch folder, with dated claims, primary source links, caveats and a Sources section. Give the report path and main findings.' },
    { id: 'review', kind: 'agent', agent: 'claude', mode: 'read-only', prompt: 'Independently check the claims and sources for {{input}}. Read the report files: {{steps.research.files}}\nResearch: {{steps.research.answer}}\nUse web search to verify. Flag weak evidence, incorrect claims and missing caveats. Do not modify files.' },
    { id: 'summary', kind: 'summary', agent: 'claude', prompt: 'Give exactly 3 short spoken-ready sentences about {{input}}, then say "Full report in the conversation". Research: {{steps.research.answer}}\nVerification: {{steps.review.answer}}' },
  ] },
  { id: 'ship-a-fix', name: 'Ship a fix', description: 'Claude implements and tests. Codex reviews. Publishing waits for your approval.', triggers: ['/fix', 'ship a fix'], input: { label: 'Which project and what needs fixing?', required: true }, steps: [
    { id: 'implement', kind: 'agent', agent: 'claude', mode: 'write', prompt: 'Implement this fix in the matched project worktree, with tests: {{input}}. Follow project rules. Summarize changes and tests. Do not push or open a PR yet.' },
    { id: 'review', kind: 'agent', agent: 'codex', mode: 'read-only', prompt: 'Review the diff and tests for {{input}} in this worktree. Implementation: {{steps.implement.answer}}\nFiles: {{steps.implement.files}}\nStart your answer with APPROVE or REQUEST CHANGES, then concrete reasons. Do not modify files.' },
    { id: 'revise', kind: 'agent', agent: 'claude', mode: 'write', when: "steps.review.answer contains 'REQUEST CHANGES'", prompt: 'Address the review once, with tests. Original request: {{input}}\nReview: {{steps.review.answer}}. Do not push.' },
    { id: 'rereview', kind: 'agent', agent: 'codex', mode: 'read-only', when: "steps.review.answer contains 'REQUEST CHANGES'", prompt: 'Re-review the diff and tests after these changes: {{steps.revise.answer}}\nOriginal review: {{steps.review.answer}}\nStart with APPROVE or REQUEST CHANGES and explain. Do not modify files.' },
    { id: 'approval', kind: 'approval', summary: 'Push branch and open a PR?' },
    { id: 'publish', kind: 'agent', agent: 'claude', mode: 'write', prompt: 'The owner approved pushing this task branch and opening a PR for {{input}}. Push and open the PR using the existing approval-guarded tools; approval policies still apply. Implementation: {{steps.implement.answer}}\nReview: {{steps.review.answer}}\nRe-review: {{steps.rereview.answer}}\nReturn the PR link.' },
    { id: 'summary', kind: 'summary', agent: 'claude', prompt: 'Summarize the fix, tests, review and PR in 3 short spoken sentences. {{steps.implement.answer}}\n{{steps.review.answer}}\n{{steps.rereview.answer}}\n{{steps.publish.answer}}' },
  ] },
  { id: 'morning-brief', name: 'Morning brief', description: 'Your plan usage, agent activity, today’s schedule and Inbox notes in one spoken brief.', triggers: ['/brief', 'morning brief'], input: { label: 'Anything to focus on? (optional)', required: false }, steps: [
    { id: 'gather', kind: 'gather', sources: ['usage','agents','schedule','notes:Inbox'] },
    { id: 'summary', kind: 'summary', agent: 'claude', effort: 'low', prompt: 'Give a 4–6 sentence spoken morning brief using only this Jarvis data. Distinguish unavailable data from an empty schedule. Focus: {{input}}\n{{steps.gather.answer}}' },
  ] },
];
