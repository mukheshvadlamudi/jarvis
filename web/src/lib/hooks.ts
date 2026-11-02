import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { useLive } from './live.ts';

export interface Resource<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  reload: () => void;
  setData: (fn: (d: T | null) => T | null) => void;
}

/**
 * Fetch JSON and refetch when any of `liveTypes` arrives on the event stream (debounced so a
 * burst of run events causes one refetch).
 */
export function useApi<T>(path: string | null, liveTypes: string[] = [], debounceMs = 250): Resource<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const seq = useRef(0);
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (!path) return;
    const id = ++seq.current;
    const ctrl = new AbortController();
    api<T>(path, { signal: ctrl.signal })
      .then((d) => {
        if (id === seq.current) {
          setDataState(d);
          setError(null);
        }
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError' && id === seq.current) setError(e);
      })
      .finally(() => {
        if (id === seq.current) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path]);

  useEffect(() => {
    setLoading(path !== null);
    setDataState(null);
    setError(null);
    return load();
  }, [load, path]);

  useLive(liveTypes, () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(load, debounceMs);
  });

  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  const setData = useCallback((fn: (d: T | null) => T | null) => setDataState((d) => fn(d)), []);
  return { data, error, loading, reload: load, setData };
}

/** Re-render every `ms` so relative times stay fresh. */
export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function useMedia(query: string): boolean {
  const [m, setM] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setM(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [query]);
  return m;
}

export function useLocalState<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // ignore
      }
    },
    [key],
  );
  return [v, set];
}
