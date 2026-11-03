import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../lib/live.ts';

const mocks = vi.hoisted(() => ({
  live: null as ((event: LiveEvent) => Promise<void>) | null,
  api: vi.fn(), post: vi.fn(), navigate: vi.fn(),
  voice: {
    state: { status: 'listening', awaiting: false, said: '', prefs: { enabled: true, wakeWord: true, speak: { finished: true, failed: true, approvals: true, brief: true, notify: true, confirmations: true } } },
    onUseHeard: null as ((text: string) => Promise<void>) | null,
    feedback: vi.fn(),
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

  it('explains missing wake words and recovers as a conversation', async () => {
    await mocks.voice.onUtterance?.('research backup tools');
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.voice.feedback).toHaveBeenLastCalledWith('Heard \u201cresearch backup tools\u201d \u00b7 start with \u201cJarvis\u201d', true, true);
    await mocks.voice.onUseHeard?.('research backup tools');
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith('/api/conversations', { text: 'research backup tools' });
    expect(mocks.navigate).toHaveBeenCalledWith('/c/chat');
  });

  it.each(['', 'you', 'thank you.', '[BLANK_AUDIO]', '(silence)', 'Jarvis thank you'])('rejects noise: %s', async (text) => {
    await mocks.voice.onUtterance?.(text);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.voice.feedback).toHaveBeenLastCalledWith('Not sure what you meant', false, true);
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

  describe('follow-up window', () => {
    beforeEach(() => {
      mocks.voice.setAwaiting.mockImplementation((a: boolean) => { mocks.voice.state.awaiting = a; });
    });
    afterEach(() => { mocks.voice.setAwaiting.mockReset(); mocks.voice.speak.mockReset().mockImplementation(async () => {}); });

    it('accepts a command split off the wake word by a pause, while "Yes?" is still playing', async () => {
      mocks.voice.speak.mockImplementationOnce(() => new Promise(() => {}));
      await mocks.voice.onUtterance?.('Jarvis.');
      expect(mocks.voice.speak).toHaveBeenCalledWith('Yes?');
      expect(mocks.voice.state.awaiting).toBe(true);
      mocks.post.mockImplementation(async (url: string) => (url === '/api/tasks/preview' ? { agent: 'claude', type: 'research' } : { task: { id: 't1', title: 'Research backup tools' } }));
      await mocks.voice.onUtterance?.('research backup tools');
      expect(mocks.post).toHaveBeenCalledWith('/api/tasks', { title: 'research backup tools' });
    });

    it('keeps the window open while the owner is still talking', async () => {
      await mocks.voice.onUtterance?.('Jarvis');
      mocks.voice.state.status = 'hearing';
      await vi.advanceTimersByTimeAsync(12_000);
      expect(mocks.voice.state.awaiting).toBe(true);
      mocks.voice.state.status = 'listening';
      await vi.advanceTimersByTimeAsync(2000);
      expect(mocks.voice.state.awaiting).toBe(false);
    });

    it('says "On it." for a conversation without opening a window', async () => {
      await mocks.voice.onUtterance?.('Jarvis, how are backups stored?');
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.voice.speak).toHaveBeenCalledWith('On it.');
      expect(mocks.voice.setAwaiting).not.toHaveBeenCalledWith(true);
      expect(mocks.post).toHaveBeenCalledWith('/api/conversations', { text: 'how are backups stored?' });
    });

    it('keeps announcing after one announcement fails', async () => {
      mocks.voice.speak.mockRejectedValueOnce(new Error('audio device lost'));
      await emit('notify', { message: 'First' });
      await emit('notify', { message: 'Second' });
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.voice.speak).toHaveBeenLastCalledWith('Second');
    });
  });
});
