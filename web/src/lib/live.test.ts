import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectLive, disconnectLive, subscribeLive } from './live.ts';

class FakeSource {
  static instances: FakeSource[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  handlers = new Map<string, (e: { data: string }) => void>();
  constructor() { FakeSource.instances.push(this); }
  addEventListener(t: string, fn: (e: { data: string }) => void) { this.handlers.set(t, fn); }
  close() {}
  emit(t: string, data: unknown) { this.handlers.get(t)?.({ data: JSON.stringify(data) }); }
}
afterEach(() => { disconnectLive(); vi.unstubAllGlobals(); vi.useRealTimers(); FakeSource.instances = []; });
describe('live stream recovery', () => {
  it('reconciles on reconnect and epoch change, rejecting stale source callbacks and deltas', () => {
    vi.useFakeTimers(); vi.stubGlobal('EventSource', FakeSource);
    const seen: string[] = []; const off = subscribeLive((e) => seen.push(e.type));
    connectLive(); const first = FakeSource.instances[0]; first.onopen?.(); first.emit('hello', { epoch: 'one' });
    first.onerror?.(); vi.advanceTimersByTime(1000); const second = FakeSource.instances[1]; second.onopen?.();
    second.emit('hello', { epoch: 'two' }); first.emit('run.delta', { text: 'stale' }); second.emit('run.delta', { epoch: 'one', text: 'stale' }); second.emit('run.delta', { epoch: 'two', text: 'current' });
    expect(seen.filter((t) => t === 'reconcile')).toHaveLength(2); expect(seen.filter((t) => t === 'run.delta')).toHaveLength(1);
    off();
  });
  it('cancels pending retries on deliberate disconnect', () => {
    vi.useFakeTimers(); vi.stubGlobal('EventSource', FakeSource); connectLive(); FakeSource.instances[0].onerror?.(); disconnectLive(); vi.advanceTimersByTime(20_000); expect(FakeSource.instances).toHaveLength(1);
  });
});
