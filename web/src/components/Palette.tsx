import { CalendarClock, CornerDownLeft, FileText, ListTodo, Moon, Play, Plus, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '../lib/api.ts';
import { STATUS_LABEL } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { toggleTheme } from '../lib/theme.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { Task } from '../lib/types.ts';
import { routes } from '../routes.ts';

export interface PaletteItem {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  run: () => void;
}

/** Remote sources searched as you type. Modules append here. */
export const paletteSources: Array<(q: string, signal: AbortSignal) => Promise<PaletteItem[]>> = [
  async (q, signal) => {
    const r = await api<{ tasks: Task[] }>(`/api/tasks?limit=8${q ? `&q=${encodeURIComponent(q)}` : ''}`, { signal });
    return r.tasks.map((t) => ({ id: `task:${t.id}`, group: 'Tasks', label: t.title, hint: STATUS_LABEL[t.status], icon: ListTodo, run: () => navigate(`/tasks/${t.id}`) }));
  },
  async (q, signal) => {
    if (q.length < 2) return [];
    try {
      const r = await api<{ results: Array<{ path: string; title: string }> }>(`/api/memory/search?q=${encodeURIComponent(q)}&limit=5`, { signal });
      return r.results.map((n) => ({ id: `note:${n.path}`, group: 'Notes', label: n.title, hint: n.path, icon: FileText, run: () => navigate(`/memory?note=${encodeURIComponent(n.path)}`) }));
    } catch {
      return [];
    }
  },
];

paletteSources.push(async (q, signal) => {
  if (q.length < 2) return [];
  const r = await api<{ schedules: Array<{ id: string; name: string }> }>('/api/schedules', { signal });
  return r.schedules
    .filter((x) => x.name.toLowerCase().includes(q.toLowerCase()))
    .map((x) => ({
      id: `sched:${x.id}`,
      group: 'Schedules',
      label: `Run “${x.name}” now`,
      icon: CalendarClock,
      run: () =>
        void post<{ task: Task }>(`/api/schedules/${x.id}/run-now`)
          .then((res) => toast(`Queued “${res.task.title}”`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${res.task.id}`) } }))
          .catch(toastError),
    }));
});

/** Static commands. Modules append here. */
export const paletteCommands: PaletteItem[] = [];

export function Palette({ onClose, onCapture }: { onClose: () => void; onCapture: () => void }) {
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<PaletteItem[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  useEffect(() => {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      Promise.all(paletteSources.map((s) => s(q.trim(), ctrl.signal).catch(() => [] as PaletteItem[]))).then((r) => setRemote(r.flat()));
    }, 120);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  const items = useMemo(() => {
    const ql = q.trim().toLowerCase();
    const base: PaletteItem[] = [
      { id: 'new', group: 'Actions', label: q.trim() ? `Create task: “${q.trim()}”` : 'New task', hint: 'C', icon: Plus, run: () => (q.trim() ? createQuick(q.trim()) : onCapture()) },
      { id: 'theme', group: 'Actions', label: 'Switch theme', icon: Moon, run: toggleTheme },
      ...paletteCommands,
      ...routes
        .filter((r) => r.nav)
        .map((r) => ({ id: `go:${r.path}`, group: 'Go to', label: r.title, hint: r.key ? `G ${r.key.toUpperCase()}` : undefined, icon: r.icon, run: () => navigate(r.path) })),
    ];
    const filtered = ql ? base.filter((i) => i.id === 'new' || i.label.toLowerCase().includes(ql)) : base;
    return [...filtered, ...remote];
  }, [q, remote, onCapture]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const choose = (i: PaletteItem | undefined) => {
    if (!i) return;
    onClose();
    i.run();
  };

  let lastGroup = '';
  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Search size={16} strokeWidth={1.5} color="var(--text-faint)" />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search tasks and notes, or type a command…"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[sel] ? `pi-${sel}` : undefined}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(items[sel]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 ? <div className="empty">No matches. Press Enter to create a task with this text.</div> : null}
          {items.map((it, idx) => {
            const head = it.group !== lastGroup ? <div className="palette-group" key={`g-${it.group}`}>{it.group}</div> : null;
            lastGroup = it.group;
            const Icon = it.icon;
            return (
              <div key={it.id}>
                {head}
                <button
                  id={`pi-${idx}`}
                  data-idx={idx}
                  className="palette-item"
                  role="option"
                  aria-selected={idx === sel}
                  onMouseMove={() => setSel(idx)}
                  onClick={() => choose(it)}
                >
                  <Icon size={16} strokeWidth={1.5} />
                  <span className="label">{it.label}</span>
                  {it.hint ? <span className="hint mono">{it.hint}</span> : null}
                </button>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> navigate
          </span>
          <span>
            <kbd>
              <CornerDownLeft size={10} />
            </kbd>{' '}
            open
          </span>
          <span>
            <Play size={10} /> tasks run as soon as a slot is free
          </span>
        </div>
      </div>
    </>
  );
}

async function createQuick(title: string) {
  try {
    const r = await post<{ task: Task }>('/api/tasks', { title });
    toast(`Queued “${r.task.title}”`, { kind: 'success', action: { label: 'Open', run: () => navigate(`/tasks/${r.task.id}`) } });
  } catch (err) {
    toastError(err);
  }
}
