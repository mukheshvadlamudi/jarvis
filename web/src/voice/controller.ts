import { api, post } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { subscribeLive } from '../lib/live.ts';
import { toast } from '../lib/toast.ts';
import type { Approval, Task, UsageState } from '../lib/types.ts';
import { voice } from './engine.ts';
import { isNoise, parseUtterance, stripWake } from './intents.ts';
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
  const finishedRuns = new Set<string>();
  const active = new Map<string, { task: Promise<Task | undefined>; activity: string; answering: boolean; timer: number | null }>();
  let lastCueAt = 0;
  let disposed = false;

  const track = (runId: string, taskId: string) => {
    let run = active.get(runId);
    if (!run) {
      const cached = titles.get(taskId);
      const task = cached?.mode ? Promise.resolve(cached) : api<{ task: Task }>(`/api/tasks/${taskId}`).then((r) => r.task).catch(() => undefined);
      run = { task, activity: '', answering: false, timer: null };
      active.set(runId, run);
    }
    return run;
  };

  const chatSpeech = (text: string, valid: () => boolean = () => true, windowMs = 0) => {
    queue = queue.then(async () => {
      if (disposed || !text || spokenChat.has(text) || !voice.state.prefs.enabled || !isLeader() || !valid()) return;
      spokenChat.add(text);
      await voice.speak(text);
      if (windowMs && !disposed) openWindow(windowMs);
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
          if (active.get(runId) !== run || run.answering || run.activity !== text || Date.now() - lastCueAt < 8000 || voice.state.awaiting || !['idle', 'listening'].includes(voice.state.status)) return false;
          lastCueAt = Date.now();
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
    queue = Promise.resolve();
    voice.stopSpeaking();
    void voice.speak(text).then(() => {
      if (windowMs) openWindow(windowMs);
    });
  };
  const announce = (text: string, windowMs = 0) => {
    if (voice.state.status === 'off' && !voice.state.prefs.enabled) return;
    // One failed line must not block every later announcement.
    queue = queue.then(() => voice.speak(text)).then(() => {
      if (windowMs) openWindow(windowMs);
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

  const conversation = async (text: string) => {
    voice.feedback('Opening a conversation\u2026');
    const r = await post<{ conversation: Task }>('/api/conversations', { text });
    lastCreated = r.conversation.id;
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
    voice.feedback(intent.kind === 'task' || intent.kind === 'conversation' ? 'Preparing request\u2026' : 'Command recognised');
    voice.setAwaiting(false);
    try {
      switch (intent.kind) {
        case 'wake':
          // Open the window now, not after "Yes?": the VAD often splits "Jarvis … research X" in two.
          openWindow();
          return reply('Yes?');
        case 'stop':
          queue = Promise.resolve();
          return voice.stopSpeaking();
        case 'repeat':
          return reply(voice.state.said || 'I have not said anything yet.');
        case 'mute':
          await voice.speak('Going quiet. Turn voice back on from the sidebar.');
          return void voice.stop();
        case 'approve':
        case 'reject': {
          const r = await api<{ approvals: Approval[] }>('/api/approvals?status=pending');
          const target = r.approvals.find((a) => a.id === pendingApproval) ?? r.approvals[0];
          if (!target) return reply('Nothing is waiting for your approval.');
          await post(`/api/approvals/${target.id}`, { decision: intent.kind === 'approve' ? 'approved' : 'rejected', note: intent.kind === 'reject' ? intent.note : 'Approved by voice', via: 'web' });
          pendingApproval = null;
          return reply(intent.kind === 'approve' ? `Approved. ${toSpeech(target.summary, 120)}.` : 'Rejected. The agent will skip it.');
        }
        case 'status': {
          const s = await api<{ counts: Record<string, number>; approvals: number }>('/api/summary');
          const running = await api<{ tasks: Task[] }>('/api/tasks?status=running&limit=3');
          const names = running.tasks.map((t) => `${t.title} on ${agentName(t.agent)}`).join('; ');
          return reply(
            `${s.counts.running ? `${s.counts.running} running${names ? `: ${names}` : ''}.` : 'Nothing is running.'} ${s.counts.queued ? `${s.counts.queued} queued.` : ''} ${s.approvals ? `${s.approvals} waiting for your approval.` : ''}`.trim(),
          );
        }
        case 'usage': {
          const u = await api<{ current: UsageState }>('/api/usage?days=1');
          const p = (w: { usedPercent: number } | null) => (w ? `${Math.round(w.usedPercent)} percent` : 'unknown');
          return reply(`Claude is at ${p(u.current.claude.five_hour)} of its five hour window, ${p(u.current.claude.weekly)} weekly. Codex is at ${p(u.current.codex.five_hour)}, and ${p(u.current.codex.weekly)} weekly.`);
        }
        case 'result':
          return reply(lastFinished ? `${lastFinished.title}. ${toSpeech(lastFinished.result_summary ?? 'No summary.', 1200)}` : 'Nothing has finished yet.');
        case 'cancel': {
          if (!lastCreated) return reply('I have not started anything to cancel.');
          await post(`/api/tasks/${lastCreated}/cancel`);
          return reply('Cancelled.');
        }
        case 'conversation':
          if (voice.state.prefs.speak.confirmations) reply('On it.', 0);
          await conversation(intent.text);
          return;
        case 'task': {
          const preview = await post<{ agent: string | null; type: string }>('/api/tasks/preview', { text: intent.text });
          voice.feedback('Sending to ' + agentName(preview.agent) + '\u2026');
          const r = await post<{ task: Task }>('/api/tasks', { title: intent.text });
          lastCreated = r.task.id;
          toast(`Queued by voice: “${r.task.title}”`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${r.task.id}`) } });
          if (voice.state.prefs.speak.confirmations) reply(`On it. ${agentName(preview.agent)} is taking this ${preview.type === 'other' ? 'task' : preview.type} task.`, 4000);
          return;
        }
      }
    } catch (err) {
      voice.feedback('Voice command failed: ' + (err as Error).message);
      reply(`Sorry, that failed: ${(err as Error).message}`);
    }
  };

  const unsub = subscribeLive(async (e) => {
    if (!voice.state.prefs.enabled || voice.state.status === 'off') return;
    const p = voice.state.prefs.speak;
    if (e.type === 'task.updated' && e.data?.id) titles.set(e.data.id, e.data as Task);
    if (e.type === 'run.started' && e.data?.id) {
      const route = String(e.data.route_reason ?? '');
      if (route.startsWith('consult:') || route.startsWith('learning')) finishedRuns.add(e.data.id);
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
      if (finishedRuns.has(runId)) return;
      finishedRuns.add(runId);
      const tracked = active.get(runId);
      if (tracked?.timer !== null && tracked?.timer !== undefined) window.clearTimeout(tracked.timer);
      active.delete(runId);
      const route = String(e.data?.route_reason ?? '');
      if (route.startsWith('consult:') || route.startsWith('learning')) return;
      let t = titles.get(e.data?.task_id);
      try {
        t = (await api<{ task: Task }>(`/api/tasks/${e.data?.task_id}`)).task;
      } catch {
        // keep cached
      }
      if (!t) return;
      if (t.mode === 'chat') {
        if (e.data?.status === 'done') {
          lastFinished = { ...t, result_summary: e.data.answer ?? t.result_summary };
          if (p.finished) chatSpeech(answerToSpeech(e.data.answer ?? ''), undefined, 6000);
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
  });

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
    disposed = true;
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
