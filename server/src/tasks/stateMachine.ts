import type { TaskStatus } from '../types.ts';

/**
 * Allowed task status transitions. `running` is only entered by the orchestrator; the owner moves
 * tasks between inbox/queued, marks them done, or cancels them.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['queued', 'done', 'cancelled'],
  queued: ['inbox', 'running', 'done', 'cancelled'],
  running: ['needs_you', 'done', 'failed', 'cancelled', 'queued'],
  needs_you: ['running', 'queued', 'done', 'failed', 'cancelled'],
  done: ['queued', 'inbox'],
  failed: ['queued', 'inbox', 'done', 'cancelled'],
  cancelled: ['queued', 'inbox'],
};

/** Transitions the owner may request directly (e.g. dragging on the Board). */
const MANUAL: Record<TaskStatus, TaskStatus[]> = {
  inbox: ['queued', 'done', 'cancelled'],
  queued: ['inbox', 'done', 'cancelled'],
  running: ['cancelled'],
  needs_you: ['queued', 'done', 'cancelled'],
  done: ['queued', 'inbox'],
  failed: ['queued', 'inbox', 'done', 'cancelled'],
  cancelled: ['queued', 'inbox'],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export function canManuallyTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from === to || MANUAL[from].includes(to);
}

export const ACTIVE_STATUSES: TaskStatus[] = ['running', 'needs_you'];
export const TERMINAL_STATUSES: TaskStatus[] = ['done', 'failed', 'cancelled'];
