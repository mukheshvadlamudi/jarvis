export interface VoiceToken { turnId: number; speechEpoch: number; generation: number }
export const SMART_REVISION = 'f766f81d3cfdf7737ac64aad813d91bbfd56bf93';
export const SAMPLE_RATE = 16000;
export const TURN_SAMPLES = 8 * SAMPLE_RATE;
export const WHISPER_CONFIG = { feature_size: 80, sampling_rate: SAMPLE_RATE, hop_length: 160, n_fft: 400, chunk_length: 8, n_samples: TURN_SAMPLES, nb_max_frames: 800, padding_value: 0 };

/** Reference pads on the left, then normalizes the entire eight-second waveform. */
export function turnWaveform(audio: Float32Array): Float32Array {
  const out = new Float32Array(TURN_SAMPLES);
  const tail = audio.subarray(Math.max(0, audio.length - TURN_SAMPLES));
  out.set(tail, TURN_SAMPLES - tail.length);
  let mean = 0;
  for (const x of out) mean += x;
  mean /= out.length;
  let variance = 0;
  for (const x of out) variance += (x - mean) ** 2;
  const scale = Math.sqrt(variance / out.length + 1e-7);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - mean) / scale;
  return out;
}

export function turnComplete(probability: number, silenceMs: number, durationMs: number): boolean {
  return probability > 0.5 || silenceMs >= 2000 || durationMs >= 30000;
}

export function spokenRun(run: { purpose?: string | null; visibility?: string | null; route_reason?: string | null }): boolean {
  if (run.visibility === 'internal' || run.visibility === 'activity') return false;
  const purpose = run.purpose ?? (/^consult:/.test(run.route_reason ?? '') ? 'consult' : /^learning/.test(run.route_reason ?? '') ? 'learning' : 'user_reply');
  return !['consult', 'learning', 'maintenance', 'verify'].includes(purpose);
}
