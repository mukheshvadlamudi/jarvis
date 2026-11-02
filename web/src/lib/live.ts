import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getToken } from './api.ts';

export interface LiveEvent {
  type: string;
  data: any;
}

type Listener = (e: LiveEvent) => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let state: 'connecting' | 'open' | 'closed' = 'closed';
const stateListeners = new Set<() => void>();
let retry = 1000;

const TYPES = [
  'hello', 'task.created', 'task.updated', 'task.deleted', 'run.started', 'run.event', 'run.delta', 'run.finished', 'agents.updated',
  'approval.created', 'approval.updated', 'usage.updated', 'project.created', 'project.updated', 'seeded',
  'memory.updated', 'memory.proposal', 'skills.updated', 'schedule.updated', 'schedule.ran', 'feed.updated', 'notify',
];

function setState(s: typeof state) {
  state = s;
  stateListeners.forEach((l) => l());
}

export function connectLive(): void {
  if (source) return;
  const token = getToken();
  setState('connecting');
  source = new EventSource(`/api/stream${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  source.onopen = () => {
    retry = 1000;
    setState('open');
  };
  source.onerror = () => {
    source?.close();
    source = null;
    setState('closed');
    setTimeout(connectLive, retry);
    retry = Math.min(retry * 2, 15_000);
  };
  for (const t of TYPES) {
    source.addEventListener(t, (ev) => {
      let data: unknown = null;
      try {
        data = JSON.parse((ev as MessageEvent).data);
      } catch {
        data = null;
      }
      listeners.forEach((l) => l({ type: t, data }));
    });
  }
}

export function disconnectLive(): void {
  source?.close();
  source = null;
  setState('closed');
}

export function subscribeLive(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Call `fn` for live events whose type matches one of `types` (prefix match with `*`). */
export function useLive(types: string[], fn: Listener): void {
  const ref = useRef(fn);
  ref.current = fn;
  const key = types.join('|');
  useEffect(() => {
    const match = (t: string) => types.some((p) => (p.endsWith('*') ? t.startsWith(p.slice(0, -1)) : p === t));
    return subscribeLive((e) => {
      if (match(e.type)) ref.current(e);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

export function useLiveState(): typeof state {
  return useSyncExternalStore(
    (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    () => state,
  );
}
