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
  purpose?: RunPurpose | null;
  visibility?: 'conversation' | 'activity' | 'internal' | null;
  owner_text?: string | null;
  parent_run_id?: string | null;
}

export type RunPurpose = 'user_reply' | 'both' | 'second_opinion' | 'consult' | 'learning' | 'handoff' | 'maintenance' | 'verify';
type TypedRun = Run & { purpose?: RunPurpose | null; visibility?: 'conversation' | 'activity' | 'internal' | null; owner_text?: string | null; parent_run_id?: string | null };

export function runPurpose(run: TypedRun): RunPurpose {
  if (run.purpose != null) return run.purpose;
  const reason = run.route_reason ?? '';
  if (reason.startsWith('side:both:')) return 'both';
  if (reason.startsWith('side:second opinion:')) return 'second_opinion';
  if (reason.startsWith('consult:')) return 'consult';
  if (reason.startsWith('learning')) return 'learning';
  return 'user_reply';
}

export function runVisibility(run: TypedRun) {
  return run.visibility ?? (['learning', 'maintenance', 'verify'].includes(runPurpose(run)) ? 'internal' : runPurpose(run) === 'consult' ? 'activity' : 'conversation');
}

/** Attach legacy side runs to the preceding owner turn; explicit parents always win. */
export function conversationTurns(runs: ConversationRun[]) {
  const turns: Array<{ run: ConversationRun; consults: ConversationRun[]; sides: ConversationRun[] }> = [];
  for (const run of runs) {
    if (runVisibility(run) === 'conversation' && !sideLabel(run)) turns.push({ run, consults: [], sides: [] });
  }
  for (const run of runs) {
    if (runVisibility(run) === 'internal') continue;
    if (runVisibility(run) !== 'activity' && !sideLabel(run)) continue;
    const parentId = (run as TypedRun).parent_run_id;
    const parent = parentId ? turns.find((t) => t.run.id === parentId) : turns.filter((t) => t.run.started_at <= run.started_at).at(-1);
    if (parent) (runVisibility(run) === 'activity' ? parent.consults : parent.sides).push(run);
  }
  return turns;
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
  if ((run as TypedRun).owner_text != null) return (run as TypedRun).owner_text!;
  return (run.prompt ?? '').split(NEW_MESSAGE).pop()!.trim();
}

/** Side runs answer beside the main thread: "Codex answered too", "Codex checked Claude". */
export function sideLabel(run: Run): { kind: 'both' | 'second opinion'; text: string } | null {
  const purpose = runPurpose(run);
  return purpose === 'both' ? { kind: 'both', text: `${agentName(run.agent)} also answered` }
    : purpose === 'second_opinion' ? { kind: 'second opinion', text: `${agentName(run.agent)}'s second opinion` } : null;
}

export const agentName = (a: string | null | undefined) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : a === 'gemini' ? 'Jarvis (voice)' : 'Jarvis');
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
  const frame = useRef<number | null>(null);
  const pending = useRef<Record<string, LiveRun>>({});
  const completed = useRef(new Set<string>());
  const generation = useRef(0);
  const idRef = useRef(id);
  idRef.current = id;

  const load = async (cid: string) => {
    const version = ++generation.current;
    try {
      const d = await api<ConversationDetail>(`/api/conversations/${cid}`);
      if (idRef.current === cid && version === generation.current) {
        completed.current = new Set(d.runs.filter((r) => r.status !== 'running').map((r) => r.id));
        for (const rid of completed.current) delete pending.current[rid];
        setLive({ ...pending.current });
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (idRef.current === cid && version === generation.current) setError(err as Error);
    }
  };

  useEffect(() => {
    setData(null);
    pending.current = {};
    completed.current.clear();
    setLive({});
    setError(null);
    if (id) void load(id);
    return () => {
      generation.current++;
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [id]);

  useEffect(() => {
    if (!id) return;
    const soon = () => {
      if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
      reloadTimer.current = window.setTimeout(() => void load(id), 120);
    };
    return subscribeLive((e) => {
      const d = e.data ?? {};
      if (e.type === 'reconcile') {
        pending.current = {};
        setLive({});
        void Promise.all([load(id), api<{ active: Array<{ taskId: string }> }>('/api/runs')]).then(([, r]) => {
          if (idRef.current === id) setData((cur) => cur ? { ...cur, active: r.active.some((a) => a.taskId === id) } : cur);
        }).catch((err) => { if (idRef.current === id) setError(err as Error); });
        return;
      }
      if (d.visibility === 'internal') return;
      const taskId = d.taskId ?? d.task_id ?? d.id;
      if (e.type === 'run.delta' && d.taskId === id) {
        if (completed.current.has(d.runId)) return;
        const prev = pending.current[d.runId] ?? { text: '', thinking: '' };
        const key = d.kind === 'thinking' ? 'thinking' : 'text';
        pending.current[d.runId] = d.kind === 'reset' ? { ...prev, text: '' } : { ...prev, [key]: d.replace ? d.text ?? '' : prev[key] + (d.text ?? '') };
        if (frame.current === null) frame.current = window.requestAnimationFrame(() => { frame.current = null; setLive({ ...pending.current }); });
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
          const prev = pending.current[ev.run_id];
          if (prev) {
            pending.current[ev.run_id] = ev.payload.role === 'reasoning' ? { ...prev, thinking: '' } : { ...prev, text: '' };
            setLive({ ...pending.current });
          }
        }
        if (!data?.runs.some((r) => r.id === ev.run_id)) soon();
        return;
      }
      if (e.type === 'run.finished' && taskId === id) {
        const runId = d.id ?? d.runId;
        completed.current.add(runId);
        setData((cur) => cur ? { ...cur, runs: cur.runs.map((r) => r.id === runId ? { ...r, ...d, events: r.events } : r) } : cur);
        delete pending.current[runId];
        setLive({ ...pending.current });
        soon();
      } else if (e.type === 'run.started' && taskId === id) soon();
      else if ((e.type === 'task.updated' || e.type.startsWith('approval.')) && (taskId === id || d.task_id === id)) soon();
    });
  }, [id, data?.runs.length]);

  return { data, error, live, reload: () => (id ? load(id) : Promise.resolve()) };
}
