import { afterEach, expect, it, vi } from 'vitest';
import { LocalTurn, SentenceStream } from './local-turn.ts';
afterEach(() => vi.useRealTimers());
it('merges a short pause and cancels a request when the owner continues before the answer', async () => {
  vi.useFakeTimers(); const send = vi.fn(async (_text: string, _signal: AbortSignal) => {}); const cancel = vi.fn(async () => {});
  const turn = new LocalTurn(send, cancel);
  turn.heard('Find the latest'); await vi.advanceTimersByTimeAsync(900); turn.speechStart(); turn.heard('GitHub trends');
  await vi.advanceTimersByTimeAsync(1200); expect(send.mock.calls[0][0]).toBe('Find the latest GitHub trends');
  const oldSignal = send.mock.calls[0][1]; turn.speechStart(); turn.heard('in TypeScript');
  await vi.advanceTimersByTimeAsync(1200); expect(oldSignal.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
  expect(send.mock.calls[1][0]).toBe('Find the latest GitHub trends in TypeScript');
  turn.answerStarted(); turn.heard('Thanks, what next?'); await vi.advanceTimersByTimeAsync(1200);
  expect(send.mock.calls[2][0]).toBe('Thanks, what next?'); turn.dispose();
});
it('stops pending dispatch when disposed', async () => {
  vi.useFakeTimers(); const send = vi.fn(); const turn = new LocalTurn(send, vi.fn()); turn.heard('Hello'); turn.dispose();
  await vi.advanceTimersByTimeAsync(2000); expect(send).not.toHaveBeenCalled();
});
it('waits for both transcriptions if Whisper finishes the first while the owner continues', async () => {
  vi.useFakeTimers(); const send = vi.fn(async (_text: string, _signal: AbortSignal) => {});
  const turn = new LocalTurn(send, vi.fn());
  turn.speechStart(); turn.speechStart(); turn.heard('The first part');
  await vi.advanceTimersByTimeAsync(2000); expect(send).not.toHaveBeenCalled();
  turn.heard('and the rest'); await vi.advanceTimersByTimeAsync(1200);
  expect(send.mock.calls[0][0]).toBe('The first part and the rest'); turn.dispose();
});
it('speaks complete streamed sentences, flushes the tail, and caps speech at three', () => {
  const stream = new SentenceStream(); expect(stream.push('Here is the')).toEqual([]);
  expect(stream.push(' answer. A second')).toEqual(['Here is the answer.']);
  expect(stream.push(' sentence! More follows. Do not read this.')).toEqual(['A second sentence!', 'More follows.']);
  expect(stream.push('', true)).toEqual([]);
  expect(new SentenceStream().push('No trailing punctuation', true)).toEqual(['No trailing punctuation']);
});
