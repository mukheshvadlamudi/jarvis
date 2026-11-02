import { ArrowUp, CornerDownLeft, Inbox } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, post } from '../lib/api.ts';
import { relTime, TYPE_LABEL } from '../lib/format.ts';
import { navigate } from '../lib/router.ts';
import { toast, toastError } from '../lib/toast.ts';
import type { AgentId, Task, TaskType } from '../lib/types.ts';
import { AgentBadge, MicButton, Segmented, Sheet } from './ui.tsx';

const EXAMPLES = [
  'Research the best Postgres backup tools for a small VPS',
  'Fix the login bug in ClientEasy',
  'Draft a friendly reply to Sam about the launch date',
  'Summarise unread email from the last two days',
  'Compare Hetzner and DigitalOcean for a 2 GB app server',
  'Write release notes for ClientEasy 2.5 from merged PRs',
];

interface Preview {
  type: TaskType;
  project: { id: string; name: string } | null;
  effort: 'low' | 'medium' | 'high';
  outward: boolean;
  agent: AgentId | null;
  reason: string | null;
  holdUntil: string | null;
}

export function CommandBar({ autoFocus, onCreated, compact }: { autoFocus?: boolean; onCreated?: (t: Task) => void; compact?: boolean }) {
  const [text, setText] = useState('');
  const [pref, setPref] = useState<'auto' | AgentId>('auto');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [example, setExample] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (text) return;
    const t = window.setInterval(() => setExample((i) => (i + 1) % EXAMPLES.length), 4500);
    return () => window.clearInterval(t);
  }, [text]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  useEffect(() => {
    const value = text.trim();
    if (value.length < 4) {
      setPreview(null);
      return;
    }
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      api<Preview>('/api/tasks/preview', { method: 'POST', body: { text: value, agent_pref: pref }, signal: ctrl.signal })
        .then(setPreview)
        .catch(() => undefined);
    }, 220);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [text, pref]);

  const create = async (run: boolean) => {
    const value = text.trim();
    if (!value || busy) return;
    const [title, ...rest] = value.split('\n');
    setBusy(true);
    try {
      const { task } = await post<{ task: Task }>('/api/tasks', { title, body: rest.join('\n').trim(), agent_pref: pref, run });
      setText('');
      setPreview(null);
      toast(run ? `Queued “${task.title}”` : `Saved “${task.title}” to the inbox`, {
        kind: 'success',
        action: { label: 'Open', run: () => navigate(`/tasks/${task.id}`) },
      });
      onCreated?.(task);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="command">
      <label htmlFor="command-input" className="sr-only">
        Describe a task
      </label>
      <textarea
        id="command-input"
        ref={ref}
        rows={1}
        value={text}
        placeholder={EXAMPLES[example]}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void create(!(e.metaKey || e.ctrlKey) || false);
          }
        }}
        style={compact ? { minHeight: 48 } : undefined}
      />
      <div className="command-foot">
        <div className="chips" aria-live="polite">
          {preview ? (
            <>
              <span className="chip">{TYPE_LABEL[preview.type]}</span>
              {preview.project ? <span className="chip">{preview.project.name}</span> : null}
              {preview.effort !== 'medium' ? <span className="chip">{preview.effort} effort</span> : null}
              {preview.outward ? <span className="chip warn">needs approval</span> : null}
              {preview.agent ? (
                <span className="chip" title={preview.reason ?? undefined}>
                  <AgentBadge agent={preview.agent} reason={preview.reason} />
                  {preview.holdUntil ? <span className="faint">waits {relTime(preview.holdUntil)}</span> : null}
                </span>
              ) : null}
            </>
          ) : (
            <span className="faint command-hint" style={{ fontSize: 12 }}>
              <CornerDownLeft size={12} strokeWidth={1.5} style={{ verticalAlign: -2 }} /> to run · Shift+Enter for a new line · first line is the title
            </span>
          )}
        </div>
        <div className="send">
          <Segmented
            label="Agent"
            value={pref}
            onChange={setPref}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
            ]}
          />
          <MicButton onText={(t) => setText((cur) => (cur && !/\s$/.test(cur) ? `${cur} ${t}` : `${cur}${t}`))} />
          <button className="btn ghost icon sm" title="Save to inbox without running" aria-label="Save to inbox" disabled={!text.trim() || busy} onClick={() => void create(false)}>
            <Inbox size={16} strokeWidth={1.5} />
          </button>
          <button className="btn primary icon sm" aria-label="Create and run" disabled={!text.trim() || busy} onClick={() => void create(true)}>
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function CaptureSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="New task" onClose={onClose}>
      <CommandBar autoFocus compact onCreated={onClose} />
      <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
        Jarvis picks the type, project and agent from your words; change the agent above if you want a specific one. Anything that sends, posts or pushes waits for your approval.
      </p>
    </Sheet>
  );
}
