import { isAbsolute, relative, resolve, win32 } from 'node:path';

export type RiskLevel = 'safe' | 'ask' | 'block';

export interface ToolCallContext {
  tool: string;
  input: Record<string, unknown>;
  cwd: string;
  vault?: string;
}

export interface RiskVerdict {
  level: RiskLevel;
  kind: string;
  reason: string;
}

const SAFE: RiskVerdict = { level: 'safe', kind: 'none', reason: 'no risky pattern' };

/** Jarvis's own MCP tools are designed to be safe (they create proposals/approvals themselves). */
const JARVIS_SAFE_TOOLS = /^mcp__jarvis__/;

const OUTWARD_MCP = /(send|post|publish|delete|create_event|reply|share|transfer|purchase)/i;

const CREDENTIAL_FILE = /(^|[\\/])(\.credentials\.json|auth\.json)$/i;
const SECRET_STORES = /(Cookies|Login Data|Web Data|key[34]\.db|logins\.json|cookies\.sqlite|Local State|signons\.sqlite|\.git-credentials|Keychains?[\\/])/i;
const SANDBOX_ESCAPE = /(--dangerously-skip-permissions|--dangerously-bypass-approvals-and-sandbox|danger-full-access|--yolo|bypassPermissions|sandbox_mode\s*=\s*["']?danger)/i;

const SHELL_ASK: Array<[RegExp, string, string]> = [
  [/\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+push\b/i, 'git_push', 'pushes commits to a remote'],
  [/\bgh\s+pr\s+(create|merge)\b/i, 'pull_request', 'opens or merges a pull request'],
  [/\bgh\s+release\s+create\b/i, 'publish', 'creates a GitHub release'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bvsce\s+publish\b/i, 'publish', 'publishes a package'],
  [
    /\b(curl|wget|http|xh)\b[^|;&]*(-X\s*(POST|PUT|DELETE|PATCH)|--request\s+(POST|PUT|DELETE|PATCH)|\s(-d|--data[\w-]*|-F|--form|--json)\s)/i,
    'http_write',
    'sends data to a web service',
  ],
  [/\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^|;&]*-Method\s+['"]?(Post|Put|Delete|Patch)/i, 'http_write', 'sends data to a web service'],
  [/\b(Send-MailMessage|sendmail|mail\s+-s)\b/i, 'send_email', 'sends an email'],
];

const WIN_ABS = /^[a-zA-Z]:[\\/]|^\\\\/;

function inside(child: string, parent: string): boolean {
  const childWin = WIN_ABS.test(child);
  const parentWin = WIN_ABS.test(parent);
  if (childWin || parentWin) {
    if (childWin !== parentWin) return false;
    const rel = win32.relative(parent.toLowerCase(), child.toLowerCase());
    return rel === '' || (!rel.startsWith('..') && !win32.isAbsolute(rel));
  }
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function pathAllowed(p: string, ctx: ToolCallContext): boolean {
  const abs = isAbsolute(p) || WIN_ABS.test(p) ? p : WIN_ABS.test(ctx.cwd) ? win32.resolve(ctx.cwd, p) : resolve(ctx.cwd, p);
  if (inside(abs, ctx.cwd)) return true;
  if (ctx.vault && inside(abs, ctx.vault)) return true;
  return false;
}

/** Extract the path operands of an `rm -r …` / `Remove-Item … -Recurse` command. */
function recursiveDeleteTargets(cmd: string): string[] | null {
  const segments = cmd.split(/&&|\|\||;|\|/);
  const targets: string[] = [];
  let found = false;
  for (const seg of segments) {
    const s = seg.trim();
    const rm = /^(?:sudo\s+)?rm\s+(.*)$/i.exec(s);
    if (rm) {
      const parts = rm[1].split(/\s+/).filter(Boolean);
      const flags = parts.filter((p) => p.startsWith('-'));
      if (flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === '--recursive')) {
        found = true;
        targets.push(...parts.filter((p) => !p.startsWith('-')).map(unquote));
      }
      continue;
    }
    const ri = /^(?:Remove-Item|rmdir|rd|del)\s+(.*)$/i.exec(s);
    if (ri && /-Recurse\b|\/s\b/i.test(ri[1])) {
      found = true;
      targets.push(
        ...ri[1]
          .split(/\s+/)
          .filter((p) => p && !p.startsWith('-') && !/^\/[a-z]$/i.test(p))
          .map(unquote),
      );
    }
  }
  return found ? targets : null;
}

function unquote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '');
}

function classifyShell(command: string, ctx: ToolCallContext): RiskVerdict {
  if (SANDBOX_ESCAPE.test(command)) return { level: 'block', kind: 'sandbox_escape', reason: 'tries to disable the sandbox or permission checks' };
  if (SECRET_STORES.test(command)) return { level: 'block', kind: 'secret_store', reason: 'touches a browser cookie/password store or credential helper' };
  if (CREDENTIAL_FILE.test(command.split(/\s+/).find((t) => CREDENTIAL_FILE.test(unquote(t))) ?? '')) {
    return { level: 'block', kind: 'credential_file', reason: 'touches an agent credential file' };
  }
  for (const [re, kind, reason] of SHELL_ASK) {
    if (re.test(command)) return { level: 'ask', kind, reason };
  }
  const targets = recursiveDeleteTargets(command);
  if (targets) {
    const outside = targets.filter((t) => !t || t === '/' || t === '~' || t.startsWith('~') || !pathAllowed(t, ctx));
    if (outside.length || targets.length === 0) {
      return { level: 'ask', kind: 'delete_outside', reason: `recursively deletes outside the task folder (${outside.join(', ') || 'unknown target'})` };
    }
  }
  return SAFE;
}

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'NotebookRead']);

function filePathOf(input: Record<string, unknown>): string | null {
  for (const k of ['file_path', 'notebook_path', 'path']) {
    if (typeof input[k] === 'string') return input[k] as string;
  }
  return null;
}

/** Classify one tool call as safe | ask | block (SPEC §8). */
export function classifyToolCall(ctx: ToolCallContext): RiskVerdict {
  const { tool, input } = ctx;

  if (tool === 'Bash' || tool === 'PowerShell' || tool === 'shell' || tool === 'command_execution') {
    const command = typeof input.command === 'string' ? input.command : Array.isArray(input.command) ? input.command.join(' ') : '';
    return classifyShell(command, ctx);
  }

  if (WRITE_TOOLS.has(tool)) {
    const p = filePathOf(input);
    if (!p) return SAFE;
    if (CREDENTIAL_FILE.test(p)) return { level: 'block', kind: 'credential_file', reason: 'writes an agent credential file' };
    const base = p.split(/[\\/]/).pop() ?? '';
    if (/^\.env(\..*)?$/.test(base) && !pathAllowed(p, { ...ctx, vault: undefined })) {
      return { level: 'block', kind: 'credential_file', reason: "writes another project's .env file" };
    }
    if (!pathAllowed(p, ctx)) return { level: 'ask', kind: 'write_outside', reason: `writes outside the task folder and vault: ${p}` };
    return SAFE;
  }

  if (READ_TOOLS.has(tool)) {
    const p = filePathOf(input);
    if (p && SECRET_STORES.test(p)) return { level: 'block', kind: 'secret_store', reason: 'reads a browser cookie/password store' };
    if (p && CREDENTIAL_FILE.test(p)) return { level: 'block', kind: 'credential_file', reason: 'reads an agent credential file' };
    return SAFE;
  }

  if (tool.startsWith('mcp__')) {
    if (JARVIS_SAFE_TOOLS.test(tool)) return SAFE;
    const name = tool.split('__').slice(2).join('__') || tool;
    if (OUTWARD_MCP.test(name)) return { level: 'ask', kind: 'outward_mcp', reason: `${name} acts outside this machine (send/post/delete/share…)` };
    return SAFE;
  }

  return SAFE;
}

/** Keyword heuristic used by the classifier to flag tasks that will act outward. */
export const OUTWARD_TASK = /(^\s*(email|e-mail|reply|message|text|post|tweet|dm)\b)|\b(send|reply to|publish|tweet|push|deploy|open (a )?pr|pull request|merge|invite|share with|purchase|buy|pay for|book an? )\b/i;
