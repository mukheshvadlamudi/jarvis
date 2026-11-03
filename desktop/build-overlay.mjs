import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { build } from 'vite';

export async function buildOverlay() {
  const require = createRequire(import.meta.url);
  await build({
    configFile: false,
    root: fileURLToPath(new URL('.', import.meta.url)),
    base: '/__desktop/',
    publicDir: false,
    resolve: { alias: { '@geist': join(dirname(require.resolve('geist/font')), 'fonts') } },
    worker: { format: 'es' },
    build: { outDir: 'overlay-build', target: 'es2022', chunkSizeWarningLimit: 2000, rollupOptions: { input: fileURLToPath(new URL('overlay.html', import.meta.url)) } },
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) await buildOverlay();
