import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../lib/live.ts';

const mocks = vi.hoisted(() => ({
  live: null as ((event: LiveEvent) => Promise<void>) | null,
  api: vi.fn(), post: vi.fn(), navigate: vi.fn(),
  voice: {
    state: { status: 'listening', awaiting: false, said: '', prefs: { enabled: true, wakeWord: true, speak: { finished: true, failed: true, approvals: true, brief: true, notify: true, confirmations: true } } },
    onUseHeard: null as ((text: string) => Promise<void>) | null,
    feedback: vi.fn(),
    speechEpoch: 0, muteMic: vi.fn(),
    onTurnStart: null as (() => void) | null,
    onStopSpeaking: null as (() => void) | null, onStopAgent: null as (() => void) | null,
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
    expect(mocks.voice.speak).toHaveBeenCalledTimes(4);
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

  it('keeps follow-ups in the active conversation until ten minutes idle or an explicit new conversation', async () => {
    vi.stubGlobal('location', { pathname: '/c/current' });
    await mocks.voice.onUtterance?.('Jarvis, what did you find?');
    expect(mocks.post).toHaveBeenLastCalledWith('/api/conversations/current/messages', { text: 'what did you find?' });
    await mocks.voice.onUtterance?.('Jarvis, research that further');
    expect(mocks.post).toHaveBeenLastCalledWith('/api/conversations/current/messages', { text: 'research that further' });
    await vi.advanceTimersByTimeAsync(600001);
    await mocks.voice.onUtterance?.('Jarvis, what now?');
    expect(mocks.post).toHaveBeenLastCalledWith('/api/conversations', { text: 'what now?' });
    await mocks.voice.onUtterance?.('Jarvis, new conversation: plan tomorrow');
    expect(mocks.post).toHaveBeenLastCalledWith('/api/conversations', { text: 'plan tomorrow' });
  });

  it('acknowledges a task before preview returns and suppresses a stopped pending submission', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.post.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = mocks.voice.onUtterance?.('Jarvis research backup tools');
    expect(mocks.voice.speak).toHaveBeenCalledWith('On it.');
    mocks.voice.onStopSpeaking?.();
    resolve({ agent: 'claude', type: 'research' }); await pending;
    expect(mocks.post).not.toHaveBeenCalledWith('/api/tasks', expect.anything());
  });

  it('does not reopen a follow-up or play queued announcements from an obsolete epoch', async () => {
    let resolve: () => void = () => {};
    mocks.voice.speak.mockImplementationOnce(() => new Promise<void>((done) => { resolve = done; }));
    await mocks.voice.onUtterance?.('Jarvis');
    await emit('notify', { message: 'Obsolete announcement' });
    mocks.voice.onStopSpeaking?.(); mocks.voice.setAwaiting.mockClear(); resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.voice.speak).not.toHaveBeenCalledWith('Obsolete announcement');
    expect(mocks.voice.setAwaiting).not.toHaveBeenCalledWith(true);
  });

  it('distinguishes mute mic, stop speaking and stop agent', async () => {
    await mocks.voice.onUtterance?.('Jarvis mute');
    expect(mocks.voice.muteMic).toHaveBeenCalledOnce(); expect(mocks.voice.stop).not.toHaveBeenCalled();
    await mocks.voice.onUtterance?.('Jarvis stop'); expect(mocks.voice.stopSpeaking).toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
    await mocks.voice.onUtterance?.('Jarvis ask what now?');
    await mocks.voice.onUtterance?.('Jarvis stop agent');
    expect(mocks.post).toHaveBeenCalledWith('/api/tasks/chat/cancel');
  });

  it('uses Space to stop speech, excluding typing fields', () => {
    const keydown = (window.addEventListener as ReturnType<typeof vi.fn>).mock.calls.find(([name]) => name === 'keydown')![1];
    mocks.voice.state.status = 'speaking';
    const preventDefault = vi.fn();
    keydown({ code: 'Space', target: { tagName: 'INPUT' }, preventDefault }); expect(mocks.voice.stopSpeaking).not.toHaveBeenCalled();
    keydown({ code: 'Space', target: { tagName: 'DIV' }, preventDefault }); expect(mocks.voice.stopSpeaking).toHaveBeenCalledOnce(); expect(preventDefault).toHaveBeenCalledOnce();
  });

  it.each(['consult', 'learning', 'maintenance', 'verify'])('does not speak %s runs even with a visible legacy prefix', async (purpose) => {
    await emit('run.finished', { id: purpose, task_id: 'chat', purpose, status: 'done', answer: 'Private instructions' });
    await vi.advanceTimersByTimeAsync(0); expect(mocks.voice.speak).not.toHaveBeenCalled();
  });

  it('reconciles completed runs once on hello after an SSE reconnect', async () => {
    await emit('run.started', { id: 'recovered', task_id: 'chat', purpose: 'user_reply' });
    mocks.api.mockImplementation(async (path: string) => path === '/api/conversations/chat' ? { runs: [{ id: 'recovered', purpose: 'user_reply', visibility: 'conversation', status: 'done', answer: 'Recovered result.' }, { id: 'private', purpose: 'verify', status: 'done', answer: 'Hidden result.' }] } : { task });
    await emit('hello', {}); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.api).toHaveBeenCalledWith('/api/conversations/chat');
    expect(mocks.voice.speak).toHaveBeenCalledExactlyOnceWith('Recovered result.');
    await emit('hello', {}); await finish('Recovered result.', 'recovered');
    await vi.advanceTimersByTimeAsync(0); expect(mocks.voice.speak).toHaveBeenCalledTimes(1);
  });

  it('opens a fresh conversation for a command after an explicit new-conversation request', async () => {
    await mocks.voice.onUtterance?.('Jarvis new conversation');
    expect(mocks.navigate).toHaveBeenCalledWith('/'); expect(mocks.post).not.toHaveBeenCalled();
    await mocks.voice.onUtterance?.('Jarvis research backup tools');
    expect(mocks.post).toHaveBeenLastCalledWith('/api/conversations', { text: 'research backup tools' });
  });

  it('invalidates an asynchronous command as soon as a newer turn starts', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.post.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = mocks.voice.onUtterance?.('Jarvis research backup tools');
    mocks.voice.onTurnStart?.(); resolve({ agent: 'claude', type: 'research' }); await pending;
    expect(mocks.post).not.toHaveBeenCalledWith('/api/tasks', expect.anything());
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
