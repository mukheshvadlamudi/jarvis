import { describe, expect, it } from 'vitest';
import { WhisperFeatureExtractor } from '@huggingface/transformers';
import { spokenRun, turnComplete, turnWaveform, WHISPER_CONFIG } from './turn.ts';

describe('Smart Turn reference preprocessing', () => {
  it('left pads and normalizes the trailing eight seconds at 16 kHz', () => {
    const pcm = turnWaveform(new Float32Array([1, 2]));
    expect(pcm).toHaveLength(128000);
    expect(pcm[0]).toBeLessThan(0);
    expect(pcm.at(-1)).toBeGreaterThan(pcm.at(-2)!);
    const mean = pcm.reduce((sum, x) => sum + x, 0) / pcm.length;
    expect(mean).toBeCloseTo(0, 6);
    const long = new Float32Array(160000); long.fill(100, 0, 32000);
    expect(turnWaveform(long).every((x) => x === 0)).toBe(true);
  });

  it('produces the reference normalized Whisper log-mel shape and silence floor', async () => {
    const extractor = new WhisperFeatureExtractor(WHISPER_CONFIG);
    const { input_features: features } = await extractor._call(turnWaveform(new Float32Array(16000)));
    expect(features.dims).toEqual([1, 80, 800]);
    expect(features.data).toHaveLength(64000);
    for (const value of features.data) expect(Number(value)).toBeCloseTo(-1.5, 5);
  });

  it('extends incomplete turns, but bounds silence and total duration', () => {
    expect(turnComplete(0.49, 300, 1000)).toBe(false);
    expect(turnComplete(0.51, 300, 1000)).toBe(true);
    expect(turnComplete(0.5, 300, 1000)).toBe(false);
    expect(turnComplete(0.1, 2000, 1000)).toBe(true);
    expect(turnComplete(0.1, 300, 30000)).toBe(true);
  });
});

describe('spoken run visibility', () => {
  it.each(['consult', 'learning', 'maintenance', 'verify'])('never speaks %s', (purpose) => {
    expect(spokenRun({ purpose })).toBe(false);
  });
  it('uses legacy prefixes only when purpose is absent', () => {
    expect(spokenRun({ route_reason: 'learning:skills' })).toBe(false);
    expect(spokenRun({ route_reason: 'consult:claude' })).toBe(false);
    expect(spokenRun({ route_reason: 'side:both:claude' })).toBe(true);
    expect(spokenRun({ purpose: 'user_reply', route_reason: 'learning:old' })).toBe(true);
    expect(spokenRun({ purpose: 'user_reply', visibility: 'internal' })).toBe(false);
  });
});
