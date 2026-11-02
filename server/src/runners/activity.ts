/**
 * One plain-English line for what an agent is doing right now, from its real tool call. Shown live
 * on Ask ("Reading server/auth.ts"), spoken by voice and sent to Telegram. Never invented: every
 * line names the actual file, command, query or note the agent touched.
 */

const short = (v: unknown, n = 80): string => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/** Last two path segments: enough to recognise a file without a wall of folders. */
const file = (v: unknown): string => {
  const p = typeof v === 'string' ? v.replace(/\\/g, '/') : '';
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join('/') : parts.join('/') || 'a file';
};

const host = (v: unknown): string => {
  try {
    return new URL(String(v)).hostname.replace(/^www\./, '');
  } catch {
    return short(v, 40) || 'a page';
  }
};

const JARVIS_TOOLS: Record<string, (i: Record<string, unknown>) => string> = {
  search_memory: (i) => `Checking your notes for “${short(i.query, 60)}”`,
  read_note: (i) => `Reading your note ${file(i.path)}`,
  save_memory: (i) => `Saving to your notes${i.target ? `: ${file(i.target)}` : ''}`,
  search_conversations: (i) => `Looking through past conversations for “${short(i.query, 60)}”`,
  consult_agent: () => 'Asking the other agent for a second opinion',
  handoff_to_agent: () => 'Planning a handoff to the other agent',
  create_task: (i) => `Creating a task: ${short(i.title, 60)}`,
  request_approval: (i) => `Asking you to approve: ${short(i.summary, 60)}`,
  notify_owner: () => 'Sending you a note',
  get_usage: () => 'Checking plan usage',
  list_projects: () => 'Looking at your projects',
};

export function activityLine(tool: string, input: Record<string, unknown> = {}): string {
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
  if (mcp) {
    const [, server, name] = mcp;
    if (server === 'jarvis' && JARVIS_TOOLS[name]) return JARVIS_TOOLS[name](input);
    return `Using ${server.replace(/^plugin_[^_]+_/, '').replace(/[_-]+/g, ' ')}: ${name.replace(/[_-]+/g, ' ')}`;
  }
  switch (tool) {
    case 'Read':
    case 'NotebookRead':
      return `Reading ${file(input.file_path ?? input.notebook_path)}`;
    case 'Write':
      return `Writing ${file(input.file_path)}`;
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `Editing ${file(input.file_path ?? input.notebook_path)}`;
    case 'Grep':
      return `Searching the code for “${short(input.pattern, 50)}”`;
    case 'Glob':
      return `Looking for files matching ${short(input.pattern, 50)}`;
    case 'LS':
      return `Listing ${file(input.path)}`;
    case 'Bash':
    case 'shell':
      return `Running ${short(input.command, 70) || 'a command'}`;
    case 'WebSearch':
    case 'web_search':
      return `Searching the web for “${short(input.query, 60)}”`;
    case 'WebFetch':
      return `Opening ${host(input.url)}`;
    case 'Task':
    case 'Agent':
      return `Starting a helper: ${short(input.description, 60) || 'subtask'}`;
    case 'TodoWrite':
      return 'Updating its plan';
    case 'Skill':
      return `Using the ${short(input.skill ?? input.name, 40) || ''} skill`.replace('the  skill', 'a skill');
    default:
      return `Using ${tool}`;
  }
}
