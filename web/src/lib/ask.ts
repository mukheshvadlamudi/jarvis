import { useEffect, useRef, useState } from 'react';
import { ApiError, api, getToken } from './api.ts';
import { subscribeLive } from './live.ts';
import type { AgentId, Approval, Run, RunEvent, Task, UsageWindow } from './types.ts';

export type AgentChoice = 'auto' | 'both' | AgentId;
export type EffortChoice = 'auto' | 'low' | 'medium' | 'high';

export interface ModelOption {
  value: string;
  label: string;
  description: string;
}

export interface AgentStatus {
  id: AgentId;
  label: string;
  state: 'ready' | 'busy' | 'signed_out' | 'limited';
  detail: string;
  signedIn: boolean;
  authError: string | null;
  busy: Array<{ taskId: string; title: string; mode: string }>;
  usage: { five_hour: UsageWindow | null; weekly: UsageWindow | null };
  models: ModelOption[];
  defaultModel: string;
  subscription: string | null;
}

export interface Uploaded {
  id: string;
  name: string;
  mime: string;
  size: number;
}

export interface ConversationRun extends Run {
  events: RunEvent[];
}

export interface ConversationDetail {
  conversation: Task;
  runs: ConversationRun[];
  approvals: Approval[];
  active: boolean;
}

export interface ConversationSummary {
  id: string;
  title: string;
  status: string;
  agent: AgentId | null;
  updated_at: string;
  preview: string;
}

/** Marks where the owner's new message starts in a prompt that also carries the conversation. */
export const NEW_MESSAGE = 'New message from the owner:\n';

/** What the owner actually typed for this run (the history handed to a joining agent is hidden). */
export function askedText(run: Run): string {
  return (run.prompt ?? '').split(NEW_MESSAGE).pop()!.trim();
}

/** Side runs answer beside the main thread: "Codex answered too", "Codex checked Claude". */
export function sideLabel(run: Run): { kind: 'both' | 'second opinion'; text: string } | null {
  const m = /^side:(both|second opinion):(.*)$/.exec(run.route_reason ?? '');
  return m ? { kind: m[1] as 'both' | 'second opinion', text: m[2] } : null;
}

export const agentName = (a: string | null | undefined) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'Jarvis');
export const otherAgent = (a: AgentId): AgentId => (a === 'claude' ? 'codex' : 'claude');

/** Upload one file as a raw body. The server copies it into the run folder when it is used. */
export async function uploadFile(file: File, signal?: AbortSignal): Promise<Uploaded> {
  const headers: Record<string, string> = { 'content-type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name || 'pasted-image.png') };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch('/api/uploads', { method: 'POST', headers, body: file, signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'offline', 'Jarvis server is not reachable.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `Upload failed (${res.status}).`);
  return data.upload as Uploaded;
}

export interface LiveRun {
  text: string;
  thinking: string;
}

/**
 * One conversation, kept current from the event stream: new runs, every stored event, and the
 * text/thinking deltas that are not stored (so the answer forms on screen as it is written).
 */
export function useConversation(id: string | null) {
  const [data, setData] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [live, setLive] = useState<Record<string, LiveRun>>({});
  const reloadTimer = useRef<number | null>(null);
  const idRef = useRef(id);
  idRef.current = id;

  const load = async (cid: string) => {
    try {
      const d = await api<ConversationDetail>(`/api/conversations/${cid}`);
      if (idRef.current === cid) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (idRef.current === cid) setError(err as Error);
    }
  };

  useEffect(() => {
    setData(null);
    setLive({});
    setError(null);
    if (id) void load(id);
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const soon = () => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => void load(id), 120);
    };
    return subscribeLive((e) => {
      const d = e.data ?? {};
      const taskId = d.taskId ?? d.task_id ?? d.id;
      if (e.type === 'run.delta' && d.taskId === id) {
        setLive((cur) => {
          const prev = cur[d.runId] ?? { text: '', thinking: '' };
          if (d.kind === 'reset') return { ...cur, [d.runId]: { text: '', thinking: prev.thinking } };
          const key = d.kind === 'thinking' ? 'thinking' : 'text';
          return { ...cur, [d.runId]: { ...prev, [key]: d.replace ? d.text ?? '' : prev[key] + (d.text ?? '') } };
        });
        return;
      }
      if (e.type === 'run.event' && d.taskId === id) {
        const ev = { id: d.id, run_id: d.run_id, ts: d.ts, kind: d.kind, payload: d.payload } as RunEvent;
        // Waiting-for-approval pings are not stored; reload so the approval card appears.
        if (!ev.id) return soon();
        setData((cur) => {
          if (!cur) return cur;
          const runs = cur.runs.map((r) => (r.id === ev.run_id && !r.events.some((x) => x.id === ev.id) ? { ...r, events: [...r.events, ev] } : r));
          return runs.some((r) => r.id === ev.run_id) ? { ...cur, runs } : cur;
        });
        // A finished message replaces the streamed text/thinking it came from.
        if (ev.kind === 'message') {
          setLive((cur) => {
            const prev = cur[ev.run_id];
            if (!prev) return cur;
            return { ...cur, [ev.run_id]: ev.payload.role === 'reasoning' ? { ...prev, thinking: '' } : { ...prev, text: '' } };
          });
        }
        if (!data?.runs.some((r) => r.id === ev.run_id)) soon();
        return;
      }
      if ((e.type === 'run.started' || e.type === 'run.finished') && taskId === id) soon();
      else if ((e.type === 'task.updated' || e.type.startsWith('approval.')) && (taskId === id || d.task_id === id)) soon();
    });
  }, [id, data?.runs.length]);

  return { data, error, live, reload: () => (id ? load(id) : Promise.resolve()) };
}
