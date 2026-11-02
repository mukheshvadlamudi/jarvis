// electron-builder configuration for the Jarvis desktop app. Run via scripts/package-desktop.mjs.
const path = require('node:path');

const stage = process.env.JARVIS_STAGE;
if (!stage) throw new Error('Run packaging through scripts/package-desktop.mjs (it stages resources/jarvis).');

module.exports = {
  appId: 'com.jarvis.desktop',
  productName: 'Jarvis',
  executableName: 'jarvis',
  copyright: 'Personal use',
  electronVersion: '45.2.1',
  directories: { output: path.join(__dirname, '..', 'dist-desktop'), buildResources: path.join(__dirname, 'assets') },
  files: ['main.mjs', 'lib.mjs', 'preload.cjs', 'splash.html', 'assets/**', 'package.json'],
  // node_modules needs its own entry: electron-builder drops nested node_modules from generic copies.
  extraResources: [
    { from: stage, to: 'jarvis', filter: ['**/*', '!node_modules{,/**}'] },
    { from: path.join(stage, 'node_modules'), to: 'jarvis/node_modules', filter: ['**/*'] },
  ],
  asar: true,
  npmRebuild: false,
  nodeGypRebuild: false,
  win: {
    target: [{ target: 'nsis' }, { target: 'portable' }],
    icon: 'assets/icon.ico',
    // Editing the .exe icon/metadata needs Windows (or wine); the CI workflow builds on Windows.
    signAndEditExecutable: process.platform === 'win32',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Jarvis',
    artifactName: 'Jarvis-Setup-${version}.${ext}',
  },
  portable: { artifactName: 'Jarvis-Portable-${version}.${ext}' },
  mac: { target: ['dmg', 'zip'], icon: 'assets/icon.png', category: 'public.app-category.productivity', artifactName: 'Jarvis-${version}-${arch}.${ext}' },
  linux: { target: ['AppImage', 'deb'], icon: 'assets/icon.png', category: 'Utility', maintainer: 'Jarvis <owner@localhost>', artifactName: 'Jarvis-${version}-${arch}.${ext}' },
};
