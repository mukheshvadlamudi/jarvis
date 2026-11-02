import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../lib/live.ts';

const mocks = vi.hoisted(() => ({
  live: null as ((event: LiveEvent) => Promise<void>) | null,
  api: vi.fn(), post: vi.fn(), navigate: vi.fn(),
  voice: {
    state: { status: 'listening', awaiting: false, said: '', prefs: { enabled: true, wakeWord: true, speak: { finished: true, failed: true, approvals: true, brief: true, notify: true, confirmations: true } } },
    onUtterance: null as ((text: string) => Promise<void>) | null,
    speak: vi.fn(async (_text: string) => {}), start: vi.fn(), stop: vi.fn(), stopSpeaking: vi.fn(), setPrefs: vi.fn(), setAwaiting: vi.fn(),
  },
}));
vi.mock('../lib/api.ts', () => ({ api: mocks.api, post: mocks.post }));
vi.mock('../lib/router.ts', () => ({ navigate: mocks.navigate }));
vi.mock('../lib/toast.ts', () => ({ toast: vi.fn() }));
vi.mock('../lib/live.ts', () => ({ subscribeLive: (fn: typeof mocks.live) => { mocks.live = fn; return () => {}; } }));
vi.mock('./engine.ts', () => ({ voice: mocks.voice }));
import { startVoiceController } from './controller.ts';

describe('Ask voice controller', () => {
  let stop: () => void;
  const task = { id: 'chat', title: 'Backups', mode: 'chat', status: 'done', result_summary: 'An old answer.' };
  const emit = async (type: string, data: Record<string, unknown>) => { await mocks.live?.({ type, data }); };
  const tool = (activity: string, runId = 'run') => emit('run.event', { taskId: 'chat', run_id: runId, kind: 'tool_call', payload: { activity } });
  const finish = (answer: string, runId = 'run') => emit('run.finished', { id: runId, task_id: 'chat', status: 'done', answer });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
    vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    vi.clearAllMocks();
    mocks.voice.state.status = 'listening';
    mocks.voice.state.awaiting = false;
    mocks.api.mockResolvedValue({ task });
    mocks.post.mockResolvedValue({ conversation: task });
    stop = startVoiceController();
  });
  afterEach(() => { stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('creates conversations and navigates to their thread for voice questions', async () => {
    await mocks.voice.onUtterance?.('Jarvis, ask how are backups stored?');
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/conversations', { text: 'how are backups stored?' });
    expect(mocks.navigate).toHaveBeenCalledWith('/c/chat');
  });

  it('skips fast activity and reads the run answer once, rather than a task summary', async () => {
    await tool('Checking backups');
    await vi.advanceTimersByTimeAsync(1500);
    await finish('**Your backups are safe.** They run daily. A third sentence. More details.');
    await finish('**Your backups are safe.** They run daily. A third sentence. More details.');
    await vi.advanceTimersByTimeAsync(9000);
    expect(mocks.voice.speak).toHaveBeenCalledExactlyOnceWith('Your backups are safe. They run daily. A third sentence.');
  });

  it('uses the newest real activity, spaces cues eight seconds apart and never repeats them', async () => {
    await tool('Reading old notes');
    await vi.advanceTimersByTimeAsync(1000);
    await tool('Checking your notes for ClientEasy backups');
    await vi.advanceTimersByTimeAsync(1000);
    expect(mocks.voice.speak).toHaveBeenCalledExactlyOnceWith('Checking your notes for ClientEasy backups');
    await tool('Looking up the backup schedule');
    await vi.advanceTimersByTimeAsync(7999);
    expect(mocks.voice.speak).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.voice.speak).toHaveBeenLastCalledWith('Looking up the backup schedule');
    await tool('Looking up the backup schedule');
    await vi.advanceTimersByTimeAsync(8000);
    expect(mocks.voice.speak).toHaveBeenCalledTimes(2);
    await finish('Backups run daily.');
    await finish('Backups run daily.', 'another-run');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.voice.speak).toHaveBeenCalledTimes(3);
  });

  it('keeps background completion, approvals and the morning brief', async () => {
    mocks.api.mockResolvedValue({ task: { ...task, mode: 'task', result_summary: 'Saved safely.' } });
    await tool('Checking backups');
    await vi.advanceTimersByTimeAsync(2500);
    expect(mocks.voice.speak).not.toHaveBeenCalled();
    await finish('Ignored chat answer.');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.voice.speak).toHaveBeenLastCalledWith('Done: Backups. Saved safely.');
    await emit('approval.created', { id: 'approval', summary: 'Send the report' });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.voice.speak).toHaveBeenLastCalledWith('Approval needed. Send the report. Say approve or reject.');
    mocks.api.mockResolvedValue({ task: { ...task, mode: 'task', title: 'Morning brief', result_summary: 'Two meetings today.' } });
    await finish('', 'brief');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.voice.speak).toHaveBeenLastCalledWith('Good morning. Two meetings today.');
  });

  it('clears pending activity when the controller is disposed', async () => {
    await tool('Checking backups');
    stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.voice.speak).not.toHaveBeenCalled();
  });

  it('drops a pending cue as soon as answer text streams in', async () => {
    await tool('Checking backups');
    await vi.advanceTimersByTimeAsync(1500);
    await emit('run.delta', { taskId: 'chat', runId: 'run', kind: 'text', text: 'Backups run daily.' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(mocks.voice.speak).not.toHaveBeenCalled();
    await finish('Backups run daily.');
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.voice.speak).toHaveBeenCalledExactlyOnceWith('Backups run daily.');
  });
});
