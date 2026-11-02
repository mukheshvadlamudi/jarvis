import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Project, Task } from '../types.ts';
import { slugify } from '../util/ids.ts';
import { logger } from '../util/log.ts';

const exec = promisify(execFile);
const log = logger('workdir');

export interface Workdir {
  cwd: string;
  kind: 'worktree' | 'scratch';
  branch?: string;
  repo?: string;
}

export function worktreePath(repoPath: string, taskId: string): string {
  return join(repoPath, '.jarvis-worktrees', taskId);
}

export function branchName(task: Pick<Task, 'id' | 'title'>): string {
  return `jarvis/${task.id}-${slugify(task.title, 32)}`;
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    await exec('git', ['-C', path, 'rev-parse', '--is-inside-work-tree'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Coding tasks on a registered git project run in `<repo>/.jarvis-worktrees/<task-id>` on branch
 * `jarvis/<task-id>-<slug>`; everything else runs in `data/workdirs/<task-id>`.
 */
export async function prepareWorkdir(task: Task, project: Project | undefined, dataDir: string): Promise<Workdir> {
  if (task.type === 'code' && project?.kind === 'code' && project.path && existsSync(project.path) && (await isGitRepo(project.path))) {
    const cwd = worktreePath(project.path, task.id);
    const branch = branchName(task);
    if (existsSync(cwd)) return { cwd, kind: 'worktree', branch, repo: project.path };
    try {
      mkdirSync(join(project.path, '.jarvis-worktrees'), { recursive: true });
      let exists = false;
      try {
        await exec('git', ['-C', project.path, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { timeout: 10_000 });
        exists = true;
      } catch {
        exists = false;
      }
      const args = exists ? ['-C', project.path, 'worktree', 'add', cwd, branch] : ['-C', project.path, 'worktree', 'add', '-b', branch, cwd];
      await exec('git', args, { timeout: 60_000 });
      return { cwd, kind: 'worktree', branch, repo: project.path };
    } catch (err) {
      log.warn(`could not create worktree for ${task.id}, using a scratch folder`, err);
    }
  }
  const cwd = join(dataDir, 'workdirs', task.id);
  mkdirSync(cwd, { recursive: true });
  return { cwd, kind: 'scratch' };
}
