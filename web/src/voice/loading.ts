export interface ModelLoad {
  status: 'loading' | 'ready' | 'failed';
  cached?: boolean;
  loaded: number;
  total: number;
}

export function modelLoadLabel(name: string, load?: ModelLoad): string {
  if (!load || load.status !== 'loading') return '';
  if (load.cached) return `Loading ${name} (saved on this device)`;
  if (load.cached === false && load.loaded > 0) {
    const mb = (bytes: number) => Math.max(0.1, Math.round(bytes / 1e5) / 10);
    return `Downloading ${name} model · ${mb(load.loaded)}${load.total > 0 ? ` of ${mb(load.total)}` : ''} MB`;
  }
  return load.cached === false ? `Downloading ${name} model` : `Loading ${name}`;
}

/** Snapshot before loading: cached reads also emit progress in transformers.js. */
export async function modelProgress(repo: string, files: string[], report: (load: ModelLoad) => void) {
  const url = (file: string) => `https://huggingface.co/${repo}/resolve/main/${file}`;
  let saved: Set<string> | null = null;
  try {
    const cache = await caches.open('transformers-cache');
    saved = new Set((await cache.keys()).map((request) => request.url));
  } catch { /* Cache Storage may be blocked. */ }
  const bytes = new Map<string, { loaded: number; total: number }>();
  const cached = saved ? files.every((file) => saved!.has(url(file))) : undefined;
  report({ status: 'loading', cached, loaded: 0, total: 0 });
  return (p: { status: string; file?: string; loaded?: number; total?: number }) => {
    if (p.status !== 'progress' || !p.file || saved?.has(url(p.file))) return;
    bytes.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
    report({ status: 'loading', cached: saved ? false : undefined,
      loaded: [...bytes.values()].reduce((sum, b) => sum + b.loaded, 0),
      total: [...bytes.values()].every((b) => b.total > 0) ? [...bytes.values()].reduce((sum, b) => sum + b.total, 0) : 0 });
  };
}
