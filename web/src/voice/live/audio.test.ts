import { describe, expect, it, vi } from 'vitest';
import { decodePcm, encodePcm, base64, PcmEncoder, PlaybackQueue, SpeechGate } from './audio.ts';

describe('PCM audio', () => {
  it('encodes clipped little endian signed PCM and decodes it', () => {
    expect([...encodePcm([-2, 0, 2])]).toEqual([0, 128, 0, 0, 255, 127]);
    expect([...decodePcm(base64(encodePcm([-1, 0, 1])))]).toEqual([-1, 0, 32767 / 32768]);
  });
  it('resamples 48k and 44.1k across arbitrary chunk boundaries into 32 ms frames', () => {
    for (const rate of [48000, 44100, 16000]) {
      const encoder = new PcmEncoder(); const chunks: Uint8Array[] = [];
      const samples = new Float32Array(rate).fill(0.5);
      for (let offset = 0; offset < rate; offset += 128) chunks.push(...encoder.push(samples.slice(offset, offset + 128), rate));
      expect(chunks).toHaveLength(31);
      expect(chunks.every((c) => c.length === 1024)).toBe(true);
      expect(decodePcm(base64(chunks[0]))[20]).toBeCloseTo(0.5, 3);
    }
  });
  it('filters high-frequency samples by averaging instead of dropping samples', () => {
    const samples = Float32Array.from({ length: 1536 }, (_, i) => i % 3 === 0 ? 1 : i % 3 === 1 ? -1 : 0);
    expect(decodePcm(base64(new PcmEncoder().push(samples, 48000)[0])).every((x) => x === 0)).toBe(true);
  });
});
describe('speech gating', () => {
  it('sends no idle silence, retains pre-roll, and signals stream end once', () => {
    const send = vi.fn(); const end = vi.fn(); const gate = new SpeechGate(send, end);
    for (let i = 0; i < 30; i++) gate.push(Uint8Array.of(i), false, true);
    expect(send).not.toHaveBeenCalled();
    gate.push(Uint8Array.of(99), true, true);
    expect(send).toHaveBeenCalledTimes(11); expect(send.mock.calls[0][0][0]).toBe(20);
    gate.push(Uint8Array.of(0), false, true); expect(send).toHaveBeenCalledTimes(11);
    gate.finish(); gate.finish(); expect(end).toHaveBeenCalledTimes(1);
  });
  it('does not retain speaker echo or muted input', () => {
    const send = vi.fn(); const gate = new SpeechGate(send, vi.fn());
    gate.push(Uint8Array.of(42), true, false); gate.push(Uint8Array.of(1), true, true);
    expect(send).toHaveBeenCalledExactlyOnceWith(Uint8Array.of(1));
  });
});
describe('playback interruption', () => {
  it('schedules gaplessly and stops every source immediately when flushed', () => {
    const sources: any[] = [];
    const context = {
      currentTime: 1, destination: {}, createAnalyser: () => ({ connect: vi.fn(), disconnect: vi.fn(), getFloatTimeDomainData: vi.fn() }),
      createBuffer: (_channels: number, length: number, rate: number) => ({ duration: length / rate, copyToChannel: vi.fn() }),
      createBufferSource: () => { const node = { connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(), onended: null }; sources.push(node); return node; },
    };
    const queue = new PlaybackQueue(context as unknown as AudioContext);
    queue.enqueue(new Float32Array(2400)); queue.enqueue(new Float32Array(2400));
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(1.115);
    expect(queue.speaking).toBe(true); queue.flush(); expect(queue.speaking).toBe(false);
    for (const source of sources) { expect(source.stop).toHaveBeenCalledOnce(); expect(source.disconnect).toHaveBeenCalledOnce(); }
    queue.enqueue(new Float32Array(2400)); expect(sources[2].start.mock.calls[0][0]).toBeCloseTo(1.015);
  });
});
