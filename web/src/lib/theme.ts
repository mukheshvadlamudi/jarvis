import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'dark' | 'light';
const KEY = 'jarvis.theme';
const listeners = new Set<() => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function setTheme(t: ThemePref): void {
  try {
    if (t === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // ignore
  }
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  listeners.forEach((l) => l());
}

export function effectiveTheme(): 'dark' | 'light' {
  const t = read();
  if (t !== 'system') return t;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function toggleTheme(): void {
  setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark');
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
  );
}
