import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveCallbacks, LiveConnectConfig } from '@google/genai';
import { LiveClient } from './client.ts';
import { liveConfig, SYSTEM_INSTRUCTION, TOOL_DECLARATIONS } from './config.ts';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function fixture() {
  vi.useFakeTimers(); vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  const sessions: Array<{ callbacks: LiveCallbacks; config: LiveConnectConfig; close: ReturnType<typeof vi.fn> }> = [];
  const request = vi.fn(async () => ({ token: 'ephemeral-fake', model: 'gemini-fake', expiresAt: new Date(Date.now() + 1800000).toISOString() }));
  const connector = vi.fn(async (_token, _model, config, callbacks) => {
    const session = { config, callbacks, close: vi.fn(), sendRealtimeInput: vi.fn(), sendClientContent: vi.fn(), sendToolResponse: vi.fn() };
    sessions.push(session); return session;
  });
  const failure = vi.fn(); const state = vi.fn();
  const client = new LiveClient({ message: vi.fn(), state, failure, request: request as any, connect: connector });
  return { client, sessions, request, connector, failure, state };
}
describe('Live session without any network', () => {
  it('renews the single-use token before expiry and resumes with the last handle', async () => {
    const f = fixture(); await f.client.start('Puck');
    f.sessions[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'resume-here' } } as any);
    await vi.advanceTimersByTimeAsync(29 * 60000);
    expect(f.request).toHaveBeenCalledTimes(2); expect(f.sessions[0].close).toHaveBeenCalledOnce();
    expect(f.sessions[1].config.sessionResumption?.handle).toBe('resume-here'); f.client.stop();
  });
  it('resumes a dropped socket and cancels reconnect on stop', async () => {
    const f = fixture(); await f.client.start('Kore');
    f.sessions[0].callbacks.onmessage({ sessionResumptionUpdate: { resumable: true, newHandle: 'r1' } } as any);
    f.sessions[0].callbacks.onclose?.({ reason: 'network lost' } as CloseEvent);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sessions[1].config.sessionResumption?.handle).toBe('r1');
    f.client.stop(); await vi.advanceTimersByTimeAsync(1800000); expect(f.request).toHaveBeenCalledTimes(2);
  });
  it('tries the fallback once on quota, then hands over to Local', async () => {
    const f = fixture(); f.connector.mockRejectedValue(new Error('429 quota reached'));
    await f.client.start('Puck');
    expect(f.request.mock.calls.map((c: any) => c[1]?.body.model)).toEqual(['primary', 'fallback']);
    expect(f.failure).toHaveBeenCalledOnce(); expect(f.client.session).toBeNull();
  });
  it('ignores stale messages after ending', async () => {
    const f = fixture(); await f.client.start('Puck'); f.client.stop();
    f.sessions[0].callbacks.onclose?.({ reason: 'closed' } as CloseEvent);
    await vi.advanceTimersByTimeAsync(5000); expect(f.request).toHaveBeenCalledOnce(); expect(f.failure).not.toHaveBeenCalled();
  });
});
it('instructs concise speech, real delegation, streaming summaries, approval, and no invented results', () => {
  for (const text of ['1–3 sentences', 'No lists or Markdown', 'ask_agent', 'While an agent works', '2–3 sentences', 'full answer is on screen', 'Confirm before anything outward-facing', 'Never invent results', 'Do not enable billing']) expect(SYSTEM_INSTRUCTION).toContain(text);
  const config = liveConfig('Kore'); expect(config.contextWindowCompression).toEqual({ slidingWindow: {} });
  expect(config.realtimeInputConfig?.automaticActivityDetection?.silenceDurationMs).toBe(1200);
  expect(TOOL_DECLARATIONS.every((t) => t.behavior === 'NON_BLOCKING')).toBe(true);
});
