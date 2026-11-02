import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { Services } from '../app.ts';
import { all, get } from '../db/index.ts';
import { estimateTokens } from '../tasks/context.ts';
import type { Approval, Project, Task } from '../types.ts';
import { logger } from '../util/log.ts';

const log = logger('projects');
const execFileP = promisify(execFile);

export type Exec = (cmd: string, args: string[], opts: { cwd: string; timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  taskId: string;
  task: Pick<Task, 'id' | 'title' | 'status' | 'output_path'> | null;
  diff: { files: number; insertions: number; deletions: number } | null;
  dirty: number;
  pr: string | null;
}

export interface ProjectInfo extends Project {
  open_tasks: number;
  exists: boolean;
  isGit: boolean;
  remote: string | null;
  branch: string | null;
  claudeMd: { tokens: number } | null;
  agentsMd: { tokens: number } | null;
  worktrees: WorktreeInfo[];
  error?: string;
}

export function parseShortstat(s: string): { files: number; insertions: number; deletions: number } {
  const n = (re: RegExp) => Number(re.exec(s)?.[1] ?? 0);
  return { files: n(/(\d+) files? changed/), insertions: n(/(\d+) insertions?\(\+\)/), deletions: n(/(\d+) deletions?\(-\)/) };
}

export function parseWorktrees(porcelain: string): Array<{ path: string; branch: string | null }> {
  const out: Array<{ path: string; branch: string | null }> = [];
  for (const block of porcelain.split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (!path) continue;
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? null;
    out.push({ path, branch });
  }
  return out;
}

/** Code projects (SPEC §12): repo registry, agent-instruction files, Jarvis worktrees, approval-gated PRs. */
export class Projects {
  private s: Services;
  exec: Exec = (cmd, args, opts) => execFileP(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });

  constructor(s: Services) {
    this.s = s;
  }

  private async git(cwd: string, args: string[]): Promise<string | null> {
    try {
      return (await this.exec('git', args, { cwd })).stdout.trim();
    } catch {
      return null;
    }
  }

  private fileInfo(path: string): { tokens: number } | null {
    return existsSync(path) && statSync(path).isFile() ? { tokens: estimateTokens(readFileSync(path, 'utf8')) } : null;
  }

  async inspect(p: Project & { open_tasks?: number }): Promise<ProjectInfo> {
    const base: ProjectInfo = { ...p, open_tasks: p.open_tasks ?? 0, exists: false, isGit: false, remote: null, branch: null, claudeMd: null, agentsMd: null, worktrees: [] };
    if (!p.path) return base;
    const root = resolve(p.path);
    if (!existsSync(root)) return { ...base, error: 'Folder not found on this machine.' };
    base.exists = true;
    base.claudeMd = this.fileInfo(join(root, 'CLAUDE.md'));
    base.agentsMd = this.fileInfo(join(root, 'AGENTS.md'));
    const inside = await this.git(root, ['rev-parse', '--is-inside-work-tree']);
    if (inside !== 'true') return base;
    base.isGit = true;
    base.remote = await this.git(root, ['remote', 'get-url', 'origin']);
    base.branch = await this.git(root, ['symbolic-ref', '--short', 'HEAD']);
    const list = await this.git(root, ['worktree', 'list', '--porcelain']);
    const jarvisDir = join(root, '.jarvis-worktrees');
    for (const wt of parseWorktrees(list ?? '')) {
      const abs = resolve(wt.path);
      if (!abs.startsWith(jarvisDir)) continue;
      const taskId = abs.slice(jarvisDir.length + 1).split(/[\\/]/)[0];
      const task = get<Task>(this.s.db, 'SELECT id, title, status, output_path FROM tasks WHERE id = ?', taskId) ?? null;
      const stat = wt.branch && base.branch ? await this.git(root, ['diff', '--shortstat', `${base.branch}...${wt.branch}`]) : null;
      const dirty = ((await this.git(abs, ['status', '--porcelain'])) ?? '').split('\n').filter(Boolean).length;
      base.worktrees.push({ path: abs, branch: wt.branch, taskId, task, diff: stat !== null ? parseShortstat(stat) : null, dirty, pr: task?.output_path?.startsWith('http') ? task.output_path : null });
    }
    return base;
  }

  async list(): Promise<ProjectInfo[]> {
    const rows = all<Project & { open_tasks: number }>(
      this.s.db,
      `SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled','failed')) AS open_tasks
       FROM projects p ORDER BY CASE p.kind WHEN 'code' THEN 0 WHEN 'client' THEN 1 ELSE 2 END, p.name`,
    );
    return Promise.all(rows.map((r) => this.inspect(r)));
  }

  private worktree(projectId: string, taskId: string): { project: Project; wt: string } {
    const project = get<Project>(this.s.db, 'SELECT * FROM projects WHERE id = ?', projectId);
    if (!project?.path) throw new Error('This project has no local path.');
    if (!/^t_[a-z0-9]+$/.test(taskId)) throw new Error('invalid task id');
    const wt = join(resolve(project.path), '.jarvis-worktrees', taskId);
    if (!existsSync(wt)) throw new Error('No Jarvis worktree for that task.');
    return { project, wt };
  }

  /** Ask the owner before pushing and opening a PR; the work happens in `handleOpenPr` on approval. */
  async requestPr(projectId: string, taskId: string): Promise<Approval> {
    const { project, wt } = this.worktree(projectId, taskId);
    const branch = await this.git(wt, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch) throw new Error('Could not read the worktree branch.');
    const task = this.s.tasks.get(taskId);
    const command = `git push -u origin ${branch}\ngh pr create --head ${branch} --fill`;
    return this.s.approvals.create({
      runId: null,
      taskId,
      kind: 'pull_request',
      summary: `Push ${branch} and open a pull request on ${project.repo ?? project.name}`,
      reason: task?.result_summary ?? 'Requested from the Projects page.',
      detail: { action: 'open_pr', projectId, taskId, branch, tool: 'gh', input: { command } },
    });
  }

  async handleOpenPr(a: Approval, decision: 'approved' | 'rejected'): Promise<void> {
    if (decision !== 'approved') return;
    const d = JSON.parse(a.detail_json) as { projectId: string; taskId: string; branch: string };
    try {
      const { wt } = this.worktree(d.projectId, d.taskId);
      await this.exec('git', ['push', '-u', 'origin', d.branch], { cwd: wt, timeout: 120_000 });
      const out = await this.exec('gh', ['pr', 'create', '--head', d.branch, '--fill'], { cwd: wt, timeout: 120_000 });
      const url = /(https?:\/\/\S+\/pull\/\d+)/.exec(out.stdout)?.[1] ?? out.stdout.trim().split('\n').pop() ?? '';
      const t = this.s.tasks.get(d.taskId);
      if (t) this.s.tasks.patch(d.taskId, { output_path: url, result_summary: `${t.result_summary ?? ''}\nPR opened: ${url}`.trim() });
      this.s.bus.publish('notify', { message: `Pull request opened: ${url}`, level: 'info', taskId: d.taskId });
    } catch (err) {
      const msg = (err as { stderr?: string }).stderr?.trim() || (err as Error).message;
      log.warn('open PR failed', msg);
      this.s.bus.publish('notify', { message: `Could not open the PR: ${msg.split('\n')[0]}`, level: 'warning', taskId: d.taskId });
    }
    this.s.bus.publish('project.updated', { id: d.projectId });
  }

  /** Remove a Jarvis worktree (the branch is kept). Refuses while the task is running. */
  async cleanup(projectId: string, taskId: string, force = false): Promise<void> {
    if (this.s.orchestrator.isActive(taskId)) throw new Error('That task is still running — stop it first.');
    const { project, wt } = this.worktree(projectId, taskId);
    try {
      await this.exec('git', ['worktree', 'remove', ...(force ? ['--force'] : []), wt], { cwd: resolve(project.path!) });
    } catch (err) {
      const msg = (err as { stderr?: string }).stderr ?? (err as Error).message;
      if (/contains modified or untracked files/i.test(msg)) throw new Error('The worktree has uncommitted changes. Remove anyway to discard them.');
      throw new Error(msg.trim().split('\n')[0]);
    }
    await this.git(resolve(project.path!), ['worktree', 'prune']);
    this.s.bus.publish('project.updated', { id: projectId });
  }
}
