import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

export function claudeBinary(): string | null {
  for (const name of [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
    try {
      const dir = dirname(require.resolve(`${name}/package.json`));
      for (const bin of ['claude.exe', 'claude']) if (existsSync(join(dir, bin))) return join(dir, bin);
    } catch { /* Not installed for this platform. */ }
  }
  return null;
}

export function codexEntry(): string | null {
  try {
    return join(dirname(require.resolve('@openai/codex/package.json')), 'bin', 'codex.js');
  } catch {
    return null;
  }
}
