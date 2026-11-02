// Build the Jarvis desktop installer.
//   npm run package:win    → NSIS installer + portable .exe (x64)
//   npm run package:mac    → .dmg + .zip (arm64 and x64; build on a Mac to sign)
//   npm run package:linux  → AppImage + .deb
// Options: --arch=x64|arm64  --dir (unpacked folder only, fast check)
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './agent-env.mjs';

const target = process.argv[2];
const opts = Object.fromEntries(process.argv.slice(3).filter((a) => a.startsWith('--')).map((a) => a.slice(2).split('=')).map(([k, v]) => [k, v ?? true]));
const OS = { win: 'win32', mac: 'darwin', linux: 'linux' }[target];
if (!OS) {
  console.error('usage: node scripts/package-desktop.mjs win|mac|linux [--arch=x64|arm64] [--dir]');
  process.exit(2);
}
const arch = opts.arch ?? (target === 'mac' ? 'arm64' : 'x64');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const sh = (cmd, args, cwd = ROOT, env = process.env) => {
  console.log(`\n› ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// 1. Fresh UI build.
sh(npm, ['run', 'build', '-w', 'web']);

// 2. Stage resources/jarvis: server source, built UI, demo vault, production deps for the target platform.
const stage = join(ROOT, 'build', 'desktop-stage', `${target}-${arch}`);
const app = join(stage, 'jarvis');
rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });
const server = JSON.parse(readFileSync(join(ROOT, 'server', 'package.json'), 'utf8'));
const deps = server.dependencies;
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'jarvis-runtime', private: true, type: 'module', dependencies: deps }, null, 2));
cpSync(join(ROOT, 'server', 'src'), join(app, 'server', 'src'), { recursive: true });
writeFileSync(join(app, 'server', 'package.json'), JSON.stringify({ name: '@jarvis/server', private: true, type: 'module' }, null, 2));
cpSync(join(ROOT, 'web', 'dist'), join(app, 'web', 'dist'), { recursive: true });
cpSync(join(ROOT, 'fixtures', 'vault'), join(app, 'fixtures', 'vault'), { recursive: true });
for (const f of ['.env.example', 'README.md', 'docs/INSTALL.md']) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(app, f));
sh(npm, ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', `--os=${OS}`, `--cpu=${arch}`], app);

// 3. Package with electron-builder (desktop/ is the Electron app; the stage goes in as resources/jarvis).
const builderArgs = [
  'electron-builder',
  `--${target}`,
  `--${arch}`,
  '--projectDir', join(ROOT, 'desktop'),
  '--config', 'electron-builder.config.cjs',
  '--publish', 'never',
  ...(opts.dir ? ['--dir'] : []),
];
sh(process.platform === 'win32' ? 'npx.cmd' : 'npx', builderArgs, ROOT, { ...process.env, JARVIS_STAGE: app });
console.log(`\nDone → ${join(ROOT, 'dist-desktop')}`);
