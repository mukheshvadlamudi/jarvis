import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { JARVIS_RUNNER: 'mock', JARVIS_SEED: '0' },
    testTimeout: 15000,
  },
});
