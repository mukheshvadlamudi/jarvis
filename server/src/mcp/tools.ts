/** Jarvis MCP tool definitions (pure data — imported by the stdio bridge). */
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

const str = (description: string) => ({ type: 'string', description });

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'search_memory',
    description: "Full-text search of the owner's Obsidian vault (projects, people, research, journal). Returns paths, titles and snippets. Use before asking the owner anything about their work.",
    inputSchema: { type: 'object', properties: { query: str('Words to search for'), type: { type: 'string', enum: ['project', 'person', 'area', 'research', 'journal', 'skill', 'core'], description: 'Optional note type filter' }, limit: { type: 'number', description: 'Max results (default 8)' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'read_note',
    description: 'Read one vault note by its vault-relative path, e.g. "Projects/ClientEasy.md" or "Skills/release-notes/SKILL.md".',
    inputSchema: { type: 'object', properties: { path: str('Vault-relative path') }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'save_memory',
    description: 'Propose a change to the vault. mode "append" adds lines; "replace" supplies the full new note text. Daily-log, Inbox and Research appends apply immediately; CORE.md, Projects/, People/ and Areas/ changes wait for owner approval.',
    inputSchema: { type: 'object', properties: { target: str('Vault-relative path of the note'), content: str('Text to append, or the full new note for replace'), reason: str('One line: why this should be remembered'), mode: { type: 'string', enum: ['append', 'replace'] } }, required: ['target', 'content', 'reason'], additionalProperties: false },
  },
  {
    name: 'request_approval',
    description: 'Ask the owner before any outward action (sending email/messages, posting, pushing, opening PRs, purchases, deleting outside the task folder). Waits for the decision; if it takes too long you get PENDING — stop and finish, Jarvis resumes you after the owner decides.',
    inputSchema: { type: 'object', properties: { summary: str('One sentence: exactly what will happen'), reason: str('Why it is needed'), payload: str('The exact command, message or request body'), kind: str('Short category, e.g. send_email, git_push, purchase') }, required: ['summary', 'reason', 'payload'], additionalProperties: false },
  },
  {
    name: 'consult_agent',
    description: 'Ask the OTHER agent (Claude ↔ Codex) for a second opinion mid-task: a design choice, a tricky bug, a review of a diff or draft. It reads your working folder (read-only) and answers in one short reply. Limited per task — use it for decisions that matter.',
    inputSchema: { type: 'object', properties: { question: str('A specific question'), context: str('Relevant code, diff, draft or findings (keep it short)') }, required: ['question'], additionalProperties: false },
  },
  {
    name: 'handoff_to_agent',
    description: 'When you finish, queue a follow-on task for the other agent: "review" (read-only check of your work in the same folder) or "continue" (build on it). Use when the other agent is better suited for the next step.',
    inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['review', 'continue'] }, instructions: str('What the other agent should do') }, required: ['mode'], additionalProperties: false },
  },
  {
    name: 'create_task',
    description: 'Create a follow-up task for later (it is queued unless run is false).',
    inputSchema: { type: 'object', properties: { title: str('One line'), body: str('Details'), type: { type: 'string', enum: ['code', 'research', 'write', 'admin', 'update', 'memory', 'other'] }, project: str('Project name'), agent: { type: 'string', enum: ['auto', 'claude', 'codex'] }, run: { type: 'boolean', description: 'Queue now (default) or park in the inbox' } }, required: ['title'], additionalProperties: false },
  },
  {
    name: 'update_task_status',
    description: 'Move another task to inbox, queued, done or cancelled (your own task finishes when you do).',
    inputSchema: { type: 'object', properties: { task_id: str('Task id, e.g. t_abc123'), status: { type: 'string', enum: ['inbox', 'queued', 'done', 'cancelled'] }, summary: str('Optional result summary') }, required: ['task_id', 'status'], additionalProperties: false },
  },
  {
    name: 'notify_owner',
    description: 'Send the owner a short notification (web + Telegram if configured). Use sparingly.',
    inputSchema: { type: 'object', properties: { message: str('Plain text, one or two sentences'), level: { type: 'string', enum: ['info', 'warning'] } }, required: ['message'], additionalProperties: false },
  },
  {
    name: 'list_projects',
    description: "List the owner's projects (code, client and areas) with their vault notes.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_usage',
    description: "Current Claude and Codex plan usage (5-hour and weekly windows) and when they reset.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
