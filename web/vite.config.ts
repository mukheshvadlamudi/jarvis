import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'credentialless' };
const geistFonts = join(dirname(require.resolve('geist/font')), 'fonts');
const apiPort = process.env.JARVIS_PORT || '4317';

/**
 * Self-host the voice runtime (ONNX Runtime WASM for Kokoro/Whisper, Silero VAD + its runtime) under
 * /voice-runtime so voice works offline once the models are cached. Copied into public/ at startup.
 */
/** Package folder as Node would find it from `from` (works for packages whose exports hide package.json). */
function pkgDir(name: string, from: string): string {
  for (let dir = from; ; dir = dirname(dir)) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return cand;
    if (dirname(dir) === dir) throw new Error(`Cannot find ${name} from ${from}`);
  }
}

function voiceRuntime(): Plugin {
  const copy = () => {
    const tf = pkgDir('@huggingface/transformers', import.meta.dirname);
    const root = pkgDir('onnxruntime-web', tf);
    const vadDir = pkgDir('@ricky0123/vad-web', import.meta.dirname);
    const vadOrt = pkgDir('onnxruntime-web', vadDir);
    const out = join(import.meta.dirname, 'public', 'voice-runtime');
    rmSync(out, { recursive: true, force: true });
    mkdirSync(join(out, 'ort'), { recursive: true });
    mkdirSync(join(out, 'vad'), { recursive: true });
    // Transformers/Kokoro use ORT's JSEP build (WebGPU + WASM); the VAD imports onnxruntime-web/wasm (plain build).
    for (const f of ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) cpSync(join(root, 'dist', f), join(out, 'ort', f));
    for (const f of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs']) cpSync(join(vadOrt, 'dist', f), join(out, 'vad', f));
    for (const f of ['vad.worklet.bundle.min.js', 'silero_vad_v5.onnx']) cpSync(join(vadDir, 'dist', f), join(out, 'vad', f));
  };
  return { name: 'jarvis-voice-runtime', buildStart: copy, configureServer: copy };
}

export default defineConfig({
  plugins: [react(), voiceRuntime()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web', '@huggingface/transformers', 'kokoro-js', '@ricky0123/vad-web'] },
  resolve: { alias: { '@geist': geistFonts } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    headers: ISOLATION,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  preview: { headers: ISOLATION },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 600 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
