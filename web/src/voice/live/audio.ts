/** Stateful area-average resampler; fractional samples carry across worklet messages. */
export class PcmEncoder {
  private sum = 0;
  private weight = 0;
  private pending: number[] = [];
  push(input: Float32Array, sourceRate: number): Uint8Array[] {
    const ratio = sourceRate / 16000;
    const chunks: Uint8Array[] = [];
    for (const sample of input) {
      let remaining = 1;
      while (remaining > 1e-8) {
        const take = Math.min(remaining, ratio - this.weight);
        this.sum += sample * take; this.weight += take; remaining -= take;
        if (this.weight >= ratio - 1e-8) {
          this.pending.push(Math.max(-1, Math.min(1, this.sum / ratio)));
          this.weight = 0; this.sum = 0;
          if (this.pending.length === 512) { chunks.push(encodePcm(this.pending)); this.pending = []; }
        }
      }
    }
    return chunks;
  }
}

export function encodePcm(samples: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2); const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
export function base64(bytes: Uint8Array): string {
  let text = ''; for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}
export function decodePcm(data: string): Float32Array {
  const raw = atob(data); const samples = new Float32Array(Math.floor(raw.length / 2));
  for (let i = 0; i < samples.length; i++) {
    const n = raw.charCodeAt(i * 2) | raw.charCodeAt(i * 2 + 1) << 8;
    samples[i] = (n >= 32768 ? n - 65536 : n) / 32768;
  }
  return samples;
}
export function rms(samples: ArrayLike<number>): number {
  let sum = 0; for (let i = 0; i < samples.length; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

/** Sources are scheduled against the audio clock, never against network arrival timers. */
export class PlaybackQueue {
  private head = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private analyser: AnalyserNode;
  private levels: Float32Array<ArrayBuffer>;
  constructor(privateContext: AudioContext) {
    this.context = privateContext;
    this.analyser = privateContext.createAnalyser(); this.analyser.fftSize = 256;
    this.levels = new Float32Array(256); this.analyser.connect(privateContext.destination);
  }
  private context: AudioContext;
  get speaking(): boolean { return this.sources.size > 0; }
  get level(): number { this.analyser.getFloatTimeDomainData(this.levels); return rms(this.levels); }
  enqueue(samples: Float32Array, rate = 24000) {
    const buffer = this.context.createBuffer(1, samples.length, rate); buffer.copyToChannel(new Float32Array(samples), 0);
    const source = this.context.createBufferSource(); source.buffer = buffer; source.connect(this.analyser);
    const at = Math.max(this.head, this.context.currentTime + 0.015);
    this.sources.add(source); source.onended = () => { source.disconnect(); this.sources.delete(source); };
    source.start(at); this.head = at + buffer.duration;
  }
  flush() {
    for (const source of this.sources) { source.onended = null; source.stop(); source.disconnect(); }
    this.sources.clear(); this.head = this.context.currentTime;
  }
  close() { this.flush(); this.analyser.disconnect(); }
}

/** 300 ms of pre-roll, and no transmission until Silero recognises actual speech. */
export class SpeechGate {
  private pre: Uint8Array[] = [];
  private open = false;
  constructor(privateSend: (bytes: Uint8Array) => void, privateEnd: () => void) { this.send = privateSend; this.end = privateEnd; }
  private send: (bytes: Uint8Array) => void;
  private end: () => void;
  push(bytes: Uint8Array, speech: boolean, allowed: boolean) {
    if (!allowed) { this.reset(); return; }
    if (speech) {
      if (!this.open) { for (const chunk of this.pre) this.send(chunk); this.pre = []; }
      this.open = true; this.send(bytes);
    } else {
      this.pre.push(bytes); if (this.pre.length > 10) this.pre.shift();
    }
  }
  finish() { if (this.open) this.end(); this.open = false; this.pre = []; }
  reset() { this.finish(); }
}

// Kept as a module string so Vite can ship one worklet without an additional build pipeline.
export const CAPTURE_WORKLET = `class Capture extends AudioWorkletProcessor {
  process(inputs) { const input = inputs[0]?.[0]; if (input) this.port.postMessage(input.slice()); return true; }
} registerProcessor('jarvis-capture', Capture);`;
