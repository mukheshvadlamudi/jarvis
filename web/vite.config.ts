import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);
const geistFonts = join(dirname(require.resolve('geist/font')), 'fonts');
const apiPort = process.env.JARVIS_PORT || '4317';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@geist': geistFonts } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022', chunkSizeWarningLimit: 600 },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
