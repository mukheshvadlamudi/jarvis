import { api, post } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { subscribeLive } from '../lib/live.ts';
import { toast } from '../lib/toast.ts';
import type { Approval, Task, UsageState } from '../lib/types.ts';
import { voice } from './engine.ts';
import { isNoise, parseUtterance, stripWake } from './intents.ts';
import { spokenRun } from './turn.ts';
import { answerToSpeech, toSpeech } from './speech.ts';

const FOLLOW_UP_MS = 8000;
/** When the window would close while the owner is still talking, check again this much later. */
const FOLLOW_UP_EXTEND_MS = 2000;
const LEADER_KEY = 'jarvis.voice.leader';
const me = Math.random().toString(36).slice(2);

/** Only one tab/window owns the mic and the speaker, so voice never creates duplicate tasks. */
function isLeader(): boolean {
  try {
    const raw = localStorage.getItem(LEADER_KEY);
    const cur = raw ? (JSON.parse(raw) as { id: string; ts: number }) : null;
    if (!cur || cur.id === me || Date.now() - cur.ts > 6000) {
      localStorage.setItem(LEADER_KEY, JSON.stringify({ id: me, ts: Date.now() }));
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

const agentName = (a: string | null | undefined) => (a === 'claude' ? 'Claude' : a === 'codex' ? 'Codex' : 'an agent');

export function startVoiceController(): () => void {
  let followTimer: number | null = null;
  let queue: Promise<void> = Promise.resolve();
  let lastFinished: Task | null = null;
  let lastCreated: string | null = null;
  let pendingApproval: string | null = null;
  const titles = new Map<string, Task>();
  const spokenChat = new Set<string>();
  const cueTexts = new Map<string, string>();
  let epoch = 0;
  let command = 0;
  let lastConversationAt = 0;
  let currentConversation: string | null = null;
  let conversationRequested = false;
  const activeConversation = () => typeof location !== 'undefined' ? /^\/c\/([^/]+)/.exec(location.pathname)?.[1] ?? null : currentConversation;
  const finishingRuns = new Set<string>();
  const finishedRuns = new Set<string>();
  const active = new Map<string, { taskId: string; task: Promise<Task | undefined>; activity: string; answering: boolean; timer: number | null }>();
  let lastCueAt = 0;
  let disposed = false;

  const track = (runId: string, taskId: string) => {
    let run = active.get(runId);
    if (!run) {
      const cached = titles.get(taskId);
      const task = cached?.mode ? Promise.resolve(cached) : api<{ task: Task }>(`/api/tasks/${taskId}`).then((r) => r.task).catch(() => undefined);
      run = { taskId, task, activity: '', answering: false, timer: null };
      active.set(runId, run);
    }
    return run;
  };

  const chatSpeech = (text: string, valid: () => boolean = () => true, windowMs = 0, runId?: string) => {
    const captured = epoch;
    queue = queue.then(async () => {
      if (disposed || captured !== epoch || !text || (runId !== undefined && spokenChat.has(runId)) || !voice.state.prefs.enabled || !isLeader() || !valid()) return;
      if (runId) spokenChat.add(runId);
      await voice.speak(text);
      if (windowMs && !disposed && captured === epoch) openWindow(windowMs);
    }).catch(() => undefined);
  };

  const cue = (runId: string, taskId: string, activity: string) => {
    if (finishedRuns.has(runId)) return;
    const run = track(runId, taskId);
    run.activity = toSpeech(activity, 120);
    run.answering = false;
    if (run.timer !== null) return;
    run.timer = window.setTimeout(() => {
      run.timer = null;
      void run.task.then((task) => {
        if (task?.mode !== 'chat' || active.get(runId) !== run) return;
        const text = run.activity;
        chatSpeech(text, () => {
          if (cueTexts.get(runId) === text || active.get(runId) !== run || run.answering || run.activity !== text || Date.now() - lastCueAt < 8000 || voice.state.awaiting || !['idle', 'listening'].includes(voice.state.status)) return false;
          lastCueAt = Date.now();
          cueTexts.set(runId, text);
          return true;
        });
      });
    }, Math.max(2000, lastCueAt + 8000 - Date.now()));
  };

  /** Close the follow-up window later, but never while the owner is mid-sentence or being transcribed. */
  const closeWindowIn = (ms: number) => {
    if (followTimer) window.clearTimeout(followTimer);
    followTimer = window.setTimeout(() => {
      if (voice.state.status === 'hearing' || voice.state.status === 'thinking') return closeWindowIn(FOLLOW_UP_EXTEND_MS);
      followTimer = null;
      voice.setAwaiting(false);
    }, ms);
  };
  const openWindow = (ms = FOLLOW_UP_MS) => {
    voice.setAwaiting(true);
    closeWindowIn(ms);
  };

  /** Replies to the owner interrupt anything queued; event announcements wait their turn. */
  const reply = (text: string, windowMs = FOLLOW_UP_MS) => {
    const captured = ++epoch;
    queue = Promise.resolve();
    voice.stopSpeaking(false);
    queue = voice.speak(text).then(() => {
      if (windowMs && !disposed && captured === epoch) openWindow(windowMs);
    }).catch(() => undefined);
  };
  const announce = (text: string, windowMs = 0) => {
    if (voice.state.status === 'off' && !voice.state.prefs.enabled) return;
    const captured = epoch;
    queue = queue.then(async () => {
      if (disposed || captured !== epoch || !voice.state.prefs.enabled || !isLeader()) return;
      await voice.speak(text);
      if (windowMs && !disposed && captured === epoch) openWindow(windowMs);
    }).catch(() => undefined);
  };

  const heartbeat = window.setInterval(() => {
    const p = voice.state.prefs;
    if (!p.enabled) return;
    if (isLeader()) {
      if (voice.state.status === 'off') void voice.start();
    } else if (voice.state.status !== 'off') {
      void voice.stop().then(() => voice.setPrefs({ enabled: true }));
    }
  }, 3000);
  if (voice.state.prefs.enabled && isLeader()) void voice.start();

  const conversation = async (text: string, fresh = false, accepted = command) => {
    voice.feedback('Opening a conversation\u2026');
    const existing = activeConversation();
    if (!fresh && existing && (!lastConversationAt || Date.now() - lastConversationAt < 600000)) {
      if (disposed || accepted !== command) return;
      await post('/api/conversations/' + encodeURIComponent(existing) + '/messages', { text });
      if (disposed || accepted !== command) return;
      lastCreated = existing; currentConversation = existing; lastConversationAt = Date.now();
      conversationRequested = false;
      return;
    }
    if (disposed || accepted !== command) return;
    const r = await post<{ conversation: Task }>('/api/conversations', { text });
    if (disposed || accepted !== command) return;
    lastCreated = r.conversation.id; currentConversation = lastCreated; lastConversationAt = Date.now();
    conversationRequested = false;
    navigate('/c/' + r.conversation.id);
  };
  voice.onUseHeard = async (text) => {
    try { await conversation(text); }
    catch (err) { voice.feedback('Could not open conversation: ' + (err as Error).message); }
  };

  voice.onUtterance = async (text) => {
    const intent = parseUtterance(text, { requireWake: voice.state.prefs.wakeWord, awaiting: voice.state.awaiting });
    if (intent.kind === 'ignore') {
      const noise = isNoise(text) || (stripWake(text) !== null && isNoise(stripWake(text)!));
      voice.feedback(noise ? 'Not sure what you meant' : 'Heard \u201c' + text + '\u201d \u00b7 start with \u201cJarvis\u201d', !noise, true);
      return;
    }
    const accepted = ++command;
    voice.feedback(intent.kind === 'task' || intent.kind === 'conversation' ? 'Preparing request\u2026' : 'Command recognised');
    voice.setAwaiting(false);
    try {
      switch (intent.kind) {
        case 'wake':
          // Open the window now, not after "Yes?": the VAD often splits "Jarvis … research X" in two.
          openWindow();
          return reply('Yes?');
        case 'stop':
          ++epoch; queue = Promise.resolve();
          return voice.stopSpeaking();
        case 'repeat':
          return reply(voice.state.said || 'I have not said anything yet.');
        case 'mute':
          voice.muteMic();
          return;
        case 'approve':
        case 'reject': {
          const r = await api<{ approvals: Approval[] }>('/api/approvals?status=pending');
          if (disposed || accepted !== command) return;
          const target = r.approvals.find((a) => a.id === pendingApproval) ?? r.approvals[0];
          if (!target) return reply('Nothing is waiting for your approval.');
          await post(`/api/approvals/${target.id}`, { decision: intent.kind === 'approve' ? 'approved' : 'rejected', note: intent.kind === 'reject' ? intent.note : 'Approved by voice', via: 'web' });
          if (disposed || accepted !== command) return;
          pendingApproval = null;
          return reply(intent.kind === 'approve' ? `Approved. ${toSpeech(target.summary, 120)}.` : 'Rejected. The agent will skip it.');
        }
        case 'status': {
          const s = await api<{ counts: Record<string, number>; approvals: number }>('/api/summary');
          const running = await api<{ tasks: Task[] }>('/api/tasks?status=running&limit=3');
          if (disposed || accepted !== command) return;
          const names = running.tasks.map((t) => `${t.title} on ${agentName(t.agent)}`).join('; ');
          return reply(
            `${s.counts.running ? `${s.counts.running} running${names ? `: ${names}` : ''}.` : 'Nothing is running.'} ${s.counts.queued ? `${s.counts.queued} queued.` : ''} ${s.approvals ? `${s.approvals} waiting for your approval.` : ''}`.trim(),
          );
        }
        case 'usage': {
          const u = await api<{ current: UsageState }>('/api/usage?days=1');
          if (disposed || accepted !== command) return;
          const p = (w: { usedPercent: number } | null) => (w ? `${Math.round(w.usedPercent)} percent` : 'unknown');
          return reply(`Claude is at ${p(u.current.claude.five_hour)} of its five hour window, ${p(u.current.claude.weekly)} weekly. Codex is at ${p(u.current.codex.five_hour)}, and ${p(u.current.codex.weekly)} weekly.`);
        }
        case 'result':
          return reply(lastFinished ? `${lastFinished.title}. ${toSpeech(lastFinished.result_summary ?? 'No summary.', 1200)}` : 'Nothing has finished yet.');
        case 'cancel': {
          const target = activeConversation() ?? lastCreated;
          if (!target) return reply('I have not started anything to cancel.');
          await post(`/api/tasks/${encodeURIComponent(target)}/cancel`);
          if (disposed || accepted !== command) return;
          return reply('Cancelled.');
        }
        case 'conversation':
          if (intent.fresh && !intent.text) { currentConversation = null; conversationRequested = true; lastConversationAt = 0; navigate('/'); return reply('What would you like to talk about?'); }
          if (voice.state.prefs.speak.confirmations) reply('On it.', 0);
          await conversation(intent.text, intent.fresh, accepted);
          return;
        case 'task': {
          if (voice.state.prefs.speak.confirmations) reply('On it.', 0);
          if (activeConversation() || conversationRequested) { await conversation(intent.text, false, accepted); return; }
          const preview = await post<{ agent: string | null; type: string }>('/api/tasks/preview', { text: intent.text });
          if (disposed || accepted !== command) return;
          voice.feedback('Sending to ' + agentName(preview.agent) + '\u2026');
          const r = await post<{ task: Task }>('/api/tasks', { title: intent.text });
          if (disposed || accepted !== command) return;
          lastCreated = r.task.id;
          toast(`Queued by voice: “${r.task.title}”`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${r.task.id}`) } });

          return;
        }
      }
    } catch (err) {
      if (disposed || accepted !== command) return;
      voice.feedback('Voice command failed: ' + (err as Error).message);
      reply(`Sorry, that failed: ${(err as Error).message}`);
    }
  };

  const handleEvent = async (e: { type: string; data: any }) => {
    const captured = epoch;
    if (!voice.state.prefs.enabled || voice.state.status === 'off') return;
    const p = voice.state.prefs.speak;
    if (e.type === 'hello') {
      const ids = new Set<string>([...active.values()].map((r) => r.taskId));
      const current = activeConversation(); if (current) ids.add(current);
      for (const id of ids) {
        try {
          const detail = await api<{ runs: Array<{ id: string; status: string }> }>('/api/conversations/' + encodeURIComponent(id));
          if (disposed || captured !== epoch) return;
          for (const run of detail.runs ?? []) if (['done', 'failed', 'cancelled'].includes(run.status)) await handleEvent({ type: 'run.finished', data: { ...run, task_id: id } });
        } catch { /* The next reconnect retries reconciliation. */ }
      }
      return;
    }
    if (e.type === 'task.updated' && e.data?.id) {
      titles.set(e.data.id, e.data as Task);
      if (e.data.id === activeConversation() && e.data.updated_at) lastConversationAt = Date.parse(e.data.updated_at) || lastConversationAt;
    }
    if (e.type === 'run.started' && e.data?.id) {
      if (!spokenRun(e.data)) finishedRuns.add(e.data.id);
      else track(e.data.id, e.data.task_id);
    }
    if (e.type === 'run.delta' && e.data?.kind === 'text' && e.data.text) {
      const run = active.get(e.data.runId);
      if (run) {
        run.answering = true;
        if (run.timer !== null) window.clearTimeout(run.timer);
        run.timer = null;
      }
    }
    if (e.type === 'run.event' && e.data?.kind === 'tool_call' && typeof e.data.payload?.activity === 'string' && p.finished) {
      cue(e.data.run_id, e.data.taskId, e.data.payload.activity);
    }
    if (e.type === 'approval.created' && p.approvals) {
      const a = e.data as Approval;
      pendingApproval = a.id;
      announce(`Approval needed. ${toSpeech(a.summary, 200)}. Say approve or reject.`, 20000);
    } else if (e.type === 'run.finished') {
      const runId = String(e.data?.id ?? '');
      if (finishedRuns.has(runId) || finishingRuns.has(runId)) return;
      finishingRuns.add(runId);
      const tracked = active.get(runId);
      if (tracked?.timer !== null && tracked?.timer !== undefined) window.clearTimeout(tracked.timer);
      if (!spokenRun(e.data)) { finishingRuns.delete(runId); finishedRuns.add(runId); return; }
      let t = titles.get(e.data?.task_id);
      try {
        t = (await api<{ task: Task }>(`/api/tasks/${e.data?.task_id}`)).task;
      } catch {
        // keep cached
      }
      finishingRuns.delete(runId);
      if (!t || disposed || captured !== epoch) return;
      active.delete(runId);
      finishedRuns.add(runId);
      if (t.mode === 'chat') {
        if (e.data?.status === 'done') {
          lastFinished = { ...t, result_summary: e.data.answer ?? t.result_summary };
          if (p.finished) chatSpeech(answerToSpeech(e.data.answer ?? ''), undefined, 6000, runId);
        } else if (e.data?.status === 'failed' && p.failed) {
          announce(`${t.title} failed. ${toSpeech(e.data.error ?? '', 200)}`);
        }
        return;
      }
      if (t.status === 'done') {
        lastFinished = t;
        const brief = /^Morning brief/.test(t.title);
        if (brief ? p.brief : p.finished) announce(brief ? `Good morning. ${toSpeech(t.result_summary ?? '', 1400)}` : `Done: ${t.title}. ${toSpeech(t.result_summary ?? '', 320)}`, 6000);
      } else if (t.status === 'failed' && p.failed) {
        announce(`${t.title} failed. ${toSpeech(t.result_summary ?? '', 200)}`);
      }
    } else if (e.type === 'notify' && p.notify) {
      announce(toSpeech(String(e.data?.message ?? ''), 300));
    }
  };
  const unsub = subscribeLive(handleEvent);
  voice.onTurnStart = () => { ++command; ++epoch; queue = Promise.resolve(); };
  voice.onStopSpeaking = () => { ++epoch; ++command; queue = Promise.resolve(); if (followTimer) window.clearTimeout(followTimer); if (!disposed && voice.state.prefs.enabled) openWindow(); };
  voice.onStopAgent = () => {
    ++command; voice.stopSpeaking();
    const target = activeConversation() ?? lastCreated;
    if (target) void post('/api/tasks/' + encodeURIComponent(target) + '/cancel').catch((error) => voice.feedback('Could not stop agent: ' + (error as Error).message));
    else voice.feedback('Nothing is running', false, true);
  };
  const keydown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (event.code !== 'Space' || event.repeat || target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(target?.tagName ?? '')) return;
    if (voice.state.status === 'speaking' || voice.state.said && voice.state.prefs.enabled) { event.preventDefault(); voice.stopSpeaking(); }
  };
  window.addEventListener('keydown', keydown);

  const release = () => {
    try {
      const raw = localStorage.getItem(LEADER_KEY);
      if (raw && (JSON.parse(raw) as { id: string }).id === me) localStorage.removeItem(LEADER_KEY);
    } catch {
      // ignore
    }
  };
  window.addEventListener('beforeunload', release);
  return () => {
    disposed = true; ++epoch; ++command;
    voice.onStopSpeaking = null; voice.onStopAgent = null; voice.onTurnStart = null;
    window.removeEventListener('keydown', keydown);
    unsub();
    if (followTimer !== null) window.clearTimeout(followTimer);
    for (const run of active.values()) if (run.timer !== null) window.clearTimeout(run.timer);
    active.clear();
    window.clearInterval(heartbeat);
    window.removeEventListener('beforeunload', release);
    release();
    voice.onUtterance = null;
    voice.onUseHeard = null;
  };
}
