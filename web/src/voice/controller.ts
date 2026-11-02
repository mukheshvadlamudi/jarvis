import { api, post } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { subscribeLive } from '../lib/live.ts';
import { toast } from '../lib/toast.ts';
import type { Approval, Task, UsageState } from '../lib/types.ts';
import { voice } from './engine.ts';
import { parseUtterance } from './intents.ts';
import { toSpeech } from './speech.ts';

const FOLLOW_UP_MS = 8000;
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

  const openWindow = (ms = FOLLOW_UP_MS) => {
    voice.setAwaiting(true);
    if (followTimer) window.clearTimeout(followTimer);
    followTimer = window.setTimeout(() => voice.setAwaiting(false), ms);
  };

  /** Replies to the owner interrupt anything queued; event announcements wait their turn. */
  const reply = (text: string, windowMs = FOLLOW_UP_MS) => {
    queue = Promise.resolve();
    voice.stopSpeaking();
    void voice.speak(text).then(() => openWindow(windowMs));
  };
  const announce = (text: string, windowMs = 0) => {
    if (voice.state.status === 'off' && !voice.state.prefs.enabled) return;
    queue = queue.then(() => voice.speak(text)).then(() => {
      if (windowMs) openWindow(windowMs);
    });
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

  voice.onUtterance = async (text) => {
    const intent = parseUtterance(text, { requireWake: voice.state.prefs.wakeWord, awaiting: voice.state.awaiting });
    if (intent.kind === 'ignore') return;
    voice.setAwaiting(false);
    try {
      switch (intent.kind) {
        case 'wake':
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
        case 'task': {
          const preview = await post<{ agent: string | null; type: string }>('/api/tasks/preview', { text: intent.text });
          const r = await post<{ task: Task }>('/api/tasks', { title: intent.text });
          lastCreated = r.task.id;
          toast(`Queued by voice: “${r.task.title}”`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${r.task.id}`) } });
          if (voice.state.prefs.speak.confirmations) reply(`On it. ${agentName(preview.agent)} is taking this ${preview.type === 'other' ? 'task' : preview.type} task.`, 4000);
          return;
        }
      }
    } catch (err) {
      reply(`Sorry, that failed: ${(err as Error).message}`);
    }
  };

  const unsub = subscribeLive(async (e) => {
    if (!voice.state.prefs.enabled || voice.state.status === 'off') return;
    const p = voice.state.prefs.speak;
    if (e.type === 'task.updated' && e.data?.id) titles.set(e.data.id, e.data as Task);
    if (e.type === 'approval.created' && p.approvals) {
      const a = e.data as Approval;
      pendingApproval = a.id;
      announce(`Approval needed. ${toSpeech(a.summary, 200)}. Say approve or reject.`, 20000);
    } else if (e.type === 'run.finished') {
      const route = String(e.data?.route_reason ?? '');
      if (route.startsWith('consult:') || route.startsWith('learning')) return;
      let t = titles.get(e.data?.task_id);
      try {
        t = (await api<{ task: Task }>(`/api/tasks/${e.data?.task_id}`)).task;
      } catch {
        // keep cached
      }
      if (!t) return;
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
    unsub();
    window.clearInterval(heartbeat);
    window.removeEventListener('beforeunload', release);
    release();
    voice.onUtterance = null;
  };
}
