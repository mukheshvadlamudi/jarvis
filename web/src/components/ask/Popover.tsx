import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** Native modal dialogs provide the focus trap and make the rest of the app inert. */
export function Popover({ title, anchor, onClose, children, search = false }: {
  title: string; anchor?: HTMLElement | null; onClose: () => void; children: ReactNode; search?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    if (anchor) {
      const bounds = anchor.getBoundingClientRect();
      if (bounds.top > window.innerHeight / 2) {
        dialog.style.setProperty('--popover-top', 'auto');
        dialog.style.setProperty('--popover-bottom', `${window.innerHeight - bounds.top + 8}px`);
      } else dialog.style.setProperty('--popover-top', `${bounds.bottom + 8}px`);
      dialog.style.setProperty('--popover-left', `${Math.max(16, Math.min(bounds.left, window.innerWidth - 416))}px`);
    }
    dialog.showModal();
    (search ? dialog.querySelector<HTMLInputElement>('input') : dialog.querySelector<HTMLElement>('button'))?.focus();
    return () => { dialog.close(); previous?.focus(); };
  }, [anchor, search]);
  return (
    <dialog ref={ref} className="ask-popover" aria-label={title} aria-modal="true" onCancel={(e) => { e.preventDefault(); close.current(); }}
      onClick={(e) => { if (e.target !== e.currentTarget) return; const b = e.currentTarget.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) close.current(); }}>
      <header className="ask-popover-head"><h2>{title}</h2><button className="btn ghost icon sm" aria-label={`Close ${title}`} onClick={onClose}><X size={16} strokeWidth={1.5} /></button></header>
      {children}
    </dialog>
  );
}
