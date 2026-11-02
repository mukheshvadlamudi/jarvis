import { describe, expect, it } from 'vitest';
import { classifyToolCall } from '../src/approvals/policy.ts';

const cwd = '/work/repo/.jarvis-worktrees/t_1';
const vault = '/vault';
const bash = (command: string) => classifyToolCall({ tool: 'Bash', input: { command }, cwd, vault }).level;

describe('risk policy', () => {
  it('asks before outward shell actions', () => {
    expect(bash('git push -u origin jarvis/t_1')).toBe('ask');
    expect(bash('git -c core.x=1 push')).toBe('ask');
    expect(bash('gh pr create --fill')).toBe('ask');
    expect(bash('gh pr merge 12 --squash')).toBe('ask');
    expect(bash('npm publish')).toBe('ask');
    expect(bash('curl -X POST https://api.example.com/x -d @a.json')).toBe('ask');
    expect(bash("Invoke-WebRequest https://x -Method Post -Body '{}'")).toBe('ask');
  });

  it('allows everyday commands', () => {
    expect(bash('git status')).toBe('safe');
    expect(bash('git commit -m "fix"')).toBe('safe');
    expect(bash('npm test')).toBe('safe');
    expect(bash('curl https://example.com')).toBe('safe');
    expect(bash('rm -rf node_modules dist')).toBe('safe');
    expect(bash('Remove-Item -Recurse build')).toBe('safe');
  });

  it('asks for recursive deletes outside the task folder', () => {
    expect(bash('rm -rf ../other-project')).toBe('ask');
    expect(bash('rm -rf /')).toBe('ask');
    expect(bash('rm -rf ~/Documents')).toBe('ask');
    expect(bash('Remove-Item -Recurse -Force C:\\Users\\owner\\Desktop')).toBe('ask');
  });

  it('blocks credential files, secret stores and sandbox escapes', () => {
    expect(bash('cat ~/.claude/.credentials.json')).toBe('block');
    expect(bash('cp x ~/.codex/auth.json')).toBe('block');
    expect(bash('sqlite3 "~/Library/Application Support/Google/Chrome/Default/Cookies"')).toBe('block');
    expect(bash('codex --dangerously-bypass-approvals-and-sandbox')).toBe('block');
    expect(classifyToolCall({ tool: 'Write', input: { file_path: '/home/me/.claude/.credentials.json' }, cwd, vault }).level).toBe('block');
    expect(classifyToolCall({ tool: 'Write', input: { file_path: '/work/other/.env' }, cwd, vault }).level).toBe('block');
    expect(classifyToolCall({ tool: 'Read', input: { file_path: 'C:\\Users\\o\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data' }, cwd, vault }).level).toBe('block');
  });

  it('gates file writes by location', () => {
    expect(classifyToolCall({ tool: 'Write', input: { file_path: `${cwd}/src/a.ts` }, cwd, vault }).level).toBe('safe');
    expect(classifyToolCall({ tool: 'Edit', input: { file_path: 'src/a.ts' }, cwd, vault }).level).toBe('safe');
    expect(classifyToolCall({ tool: 'Write', input: { file_path: '/vault/Inbox.md' }, cwd, vault }).level).toBe('safe');
    expect(classifyToolCall({ tool: 'Write', input: { file_path: '/etc/hosts' }, cwd, vault }).level).toBe('ask');
    expect(classifyToolCall({ tool: 'Write', input: { file_path: `${cwd}/.env` }, cwd, vault }).level).toBe('safe');
  });

  it('asks for outward MCP tools but trusts Jarvis tools', () => {
    expect(classifyToolCall({ tool: 'mcp__gmail__send_message', input: {}, cwd }).level).toBe('ask');
    expect(classifyToolCall({ tool: 'mcp__calendar__create_event', input: {}, cwd }).level).toBe('ask');
    expect(classifyToolCall({ tool: 'mcp__drive__share_file', input: {}, cwd }).level).toBe('ask');
    expect(classifyToolCall({ tool: 'mcp__gmail__search_threads', input: {}, cwd }).level).toBe('safe');
    expect(classifyToolCall({ tool: 'mcp__jarvis__save_memory', input: {}, cwd }).level).toBe('safe');
  });
});
