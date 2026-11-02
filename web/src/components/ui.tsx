import { AlertTriangle, ChevronRight, Loader2, Mic, MicOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode, TextareaHTMLAttributes, InputHTMLAttributes, KeyboardEvent } from 'react';
import { linkHandler } from '../lib/router.ts';
import { resetsIn, STATUS_LABEL } from '../lib/format.ts';
import { speechSupported, startDictation } from '../lib/speech.ts';
import { dismiss, toast, useToasts } from '../lib/toast.ts';
import type { AgentId, TaskStatus, UsageWindow } from '../lib/types.ts';

export function Link(props: { to: string; className?: string; children: ReactNode; title?: string; style?: React.CSSProperties; 'aria-current'?: 'page' | undefined; onClick?: () => void; role?: string }) {
  const handler = linkHandler(props.to);
  return (
    <a
      href={props.to}
      className={props.className}
      title={props.title}
      style={props.style}
      role={props.role}
      aria-current={props['aria-current']}
      onClick={(e) => {
        props.onClick?.();
        handler(e);
      }}
    >
      {props.children}
    </a>
  );
}

export function AgentBadge({ agent, reason }: { agent: AgentId | 'mock' | null | undefined; reason?: string | null }) {
  if (!agent) return <span className="agent none">Unassigned</span>;
  const name = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex' : 'Mock';
  return (
    <span className={`agent ${agent}`} title={reason ? `Routing: ${reason}` : undefined}>
      <span className="dot" aria-hidden />
      {name}
    </span>
  );
}

export function StatusLabel({ status }: { status: TaskStatus | string }) {
  return (
    <span className={`status ${status}`}>
      <span className={`dot${status === 'running' ? ' live' : ''}`} aria-hidden />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {sub ? <span className="sub">{sub}</span> : null}
      {children ? <div className="actions">{children}</div> : null}
    </header>
  );
}

export function Skeleton({ w = '100%', h = 12, style }: { w?: number | string; h?: number; style?: React.CSSProperties }) {
  return <span className="skel" style={{ width: w, height: h, ...style }} aria-hidden />;
}

export function SkeletonRows({ rows = 5, meta = true }: { rows?: number; meta?: boolean }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="row" key={i}>
          <Skeleton w={8} h={8} />
          <Skeleton w={`${55 + ((i * 17) % 35)}%`} h={12} />
          {meta ? <Skeleton w={64} h={10} style={{ marginLeft: 'auto' }} /> : null}
        </div>
      ))}
    </div>
  );
}

export function Empty({ title, children, action, center }: { title: string; children?: ReactNode; action?: ReactNode; center?: boolean }) {
  return (
    <div className={`empty${center ? ' center' : ''}`}>
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="error-box" role="alert">
      <AlertTriangle size={16} strokeWidth={1.5} color="var(--danger)" />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{error.message}</div>
      </div>
      {onRetry ? (
        <button className="btn sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <Loader2 size={size} strokeWidth={1.5} className="spin" aria-label="Working" />;
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch" disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Mic button that appends dictated text through `onText`. Hidden when unsupported. */
export function MicButton({ onText, size = 'sm' }: { onText: (text: string) => void; size?: 'sm' | 'md' }) {
  const [on, setOn] = useState(false);
  const stop = useRef<(() => void) | null>(null);
  const [supported] = useState(speechSupported);
  useEffect(() => () => stop.current?.(), []);
  if (!supported) return null;
  return (
    <button
      type="button"
      className={`btn ghost icon mic ${size === 'sm' ? 'sm' : ''}`}
      aria-label={on ? 'Stop dictation' : 'Dictate'}
      aria-pressed={on}
      title={on ? 'Stop dictation' : 'Dictate (speech to text)'}
      style={on ? { color: 'var(--accent)' } : undefined}
      onClick={() => {
        if (on) {
          stop.current?.();
          setOn(false);
          return;
        }
        setOn(true);
        stop.current = startDictation({
          onText: (finalText) => {
            if (finalText.trim()) onText(finalText.trim());
          },
          onEnd: () => setOn(false),
          onError: (msg) => {
            setOn(false);
            toast(msg, { kind: 'error' });
          },
        });
      }}
    >
      {on ? <MicOff size={16} strokeWidth={1.5} /> : <Mic size={16} strokeWidth={1.5} />}
    </button>
  );
}

const append = (cur: string, add: string) => (cur && !/\s$/.test(cur) ? `${cur} ${add}` : `${cur}${add}`);

export function TextInput(props: InputHTMLAttributes<HTMLInputElement> & { value: string; onValue: (v: string) => void; mic?: boolean }) {
  const { onValue, mic = true, className, ...rest } = props;
  return (
    <div className="input-wrap">
      <input {...rest} className={`input ${className ?? ''}`} onChange={(e) => onValue(e.target.value)} />
      {mic ? <MicButton onText={(t) => onValue(append(props.value, t))} /> : null}
    </div>
  );
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string; onValue: (v: string) => void; mic?: boolean }) {
  const { onValue, mic = true, className, ...rest } = props;
  return (
    <div className="input-wrap" style={{ alignItems: 'flex-start' }}>
      <textarea {...rest} className={`textarea ${className ?? ''}`} onChange={(e) => onValue(e.target.value)} style={{ paddingRight: 40 }} />
      {mic ? (
        <span style={{ position: 'absolute', right: 4, top: 4 }}>
          <MicButton onText={(t) => onValue(append(props.value, t))} />
        </span>
      ) : null}
    </div>
  );
}

export function Sheet({ title, onClose, children, footer, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="overlay" onClick={onClose} aria-hidden />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} ref={ref} tabIndex={-1} style={wide ? { width: 'min(760px, 100vw)' } : undefined}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {footer ? <div className="sheet-foot">{footer}</div> : null}
      </div>
    </>
  );
}

export function Toasts() {
  const toasts = useToasts();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="msg-text">{t.text}</span>
          {t.action ? (
            <button
              className="btn sm ghost"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button className="btn sm ghost icon" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function UsageBar({ agent, label, w, threshold }: { agent: AgentId; label: string; w: UsageWindow | null; threshold: number }) {
  const pct = w ? Math.max(0, Math.min(100, w.usedPercent)) : 0;
  const level = pct >= threshold ? 'hot' : pct >= 70 ? 'warn' : agent;
  return (
    <div className="meter">
      <span className="label">{label}</span>
      <div className={`bar ${level}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label={`${agent} ${label} usage`}>
        <span style={{ width: `${pct}%` }} />
        <i className="mark" style={{ left: `${threshold}%` }} title={`Router falls back at ${threshold}%`} />
      </div>
      <span className="pct">{w ? `${Math.round(pct)}%` : '—'}</span>
      <span className="reset">
        {w ? resetsIn(w.resetsAt) : 'no reading yet'}
        {w?.estimate ? ' · estimate' : ''}
      </span>
    </div>
  );
}

export function KeyHint({ keys }: { keys: string[] }) {
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {keys.map((k) => (
        <kbd key={k}>{k}</kbd>
      ))}
    </span>
  );
}

export function Disclosure({ summary, children, defaultOpen = false }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="tool" data-open={open}>
      <button className="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} strokeWidth={1.5} className="chev" />
        {summary}
      </button>
      {open ? <div className="tool-body">{children}</div> : null}
    </div>
  );
}

/** Enter submits, Shift+Enter inserts a newline. */
export function submitOnEnter(fn: () => void) {
  return (e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      fn();
    }
  };
}
