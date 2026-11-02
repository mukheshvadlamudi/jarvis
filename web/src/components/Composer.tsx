import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AgentChoice, AgentStatus, EffortChoice, Uploaded } from '../lib/ask.ts';
import { agentName, uploadFile } from '../lib/ask.ts';
import { api, post } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useLocalState } from '../lib/hooks.ts';
import { toastError } from '../lib/toast.ts';
import type { AgentId } from '../lib/types.ts';
import { MicButton } from './ui.tsx';

interface Pending {
  key: string;
  file: File;
  upload?: Uploaded;
  error?: string;
}

const AGENTS: Array<{ value: AgentChoice; label: string; hint: string }> = [
  { value: 'auto', label: 'Auto', hint: 'Jarvis picks: questions go to the plan with more room, work by type' },
  { value: 'claude', label: 'Claude', hint: 'Your Claude plan, in Claude Code' },
  { value: 'codex', label: 'Codex', hint: 'Your ChatGPT plan, in Codex' },
  { value: 'both', label: 'Both', hint: 'Both answer side by side; keep the better one' },
];
const EFFORTS: Array<{ value: EffortChoice; label: string }> = [
  { value: 'auto', label: 'Auto effort' },
  { value: 'low', label: 'Low effort' },
  { value: 'medium', label: 'Medium effort' },
  { value: 'high', label: 'High effort' },
];

export interface ComposerHandle {
  pick(agent: AgentChoice): void;
  fill(text: string): void;
}

/**
 * The Ask composer. Enter sends, Shift+Enter is a new line. Files can be attached with the clip,
 * dropped on the box or pasted (screenshots). Agent, model and effort apply to this message;
 * the last choice is remembered. Under the box: where the message will go and why.
 */
export function Composer({ conversationId, running, lastAgent, agents, onSent, onStop, handle, placeholder }: {
  conversationId: string | null;
  running: boolean;
  lastAgent: AgentId | null;
  agents: Record<AgentId, AgentStatus> | null;
  onSent: (conversationId: string) => void;
  onStop: () => void;
  handle?: (h: ComposerHandle) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [agent, setAgent] = useLocalState<AgentChoice>('jarvis.ask.agent', 'auto');
  const [models, setModels] = useLocalState<Record<string, string>>('jarvis.ask.models', {});
  const [effort, setEffort] = useLocalState<EffortChoice>('jarvis.ask.effort', 'auto');
  const [files, setFiles] = useState<Pending[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [route, setRoute] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      handle?.({
        pick: (a) => {
          setAgent(a);
          box.current?.focus();
        },
        fill: (t) => {
          setText(t);
          box.current?.focus();
        },
      }),
    [handle],
  );

  // Grow with the text, up to a third of the screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, [text]);

  // Where will this go? Follow-ups stay with the last agent unless one is picked.
  useEffect(() => {
    if (agent === 'claude' || agent === 'codex') return setRoute(`${agentName(agent)}, as you picked`);
    if (agent === 'both') return setRoute('Claude and Codex both answer');
    if (conversationId && lastAgent) return setRoute(`Continues with ${agentName(lastAgent)}`);
    const t = text.trim();
    if (!t) return setRoute(null);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      api<{ agent: AgentId | null; reason: string | null }>('/api/tasks/preview', { method: 'POST', body: { text: t, mode: 'chat' }, signal: ctrl.signal })
        .then((p) => setRoute(p.agent ? `${agentName(p.agent)} · ${p.reason ?? ''}` : null))
        .catch(() => undefined);
    }, 300);
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [text, agent, conversationId, lastAgent]);

  const add = (list: FileList | File[]) => {
    const next = [...list].slice(0, 10 - files.length).map((file) => ({ key: `${file.name}-${file.size}-${Math.random()}`, file }));
    if (!next.length) return;
    setFiles((cur) => [...cur, ...next]);
    for (const p of next) {
      uploadFile(p.file)
        .then((u) => setFiles((cur) => cur.map((x) => (x.key === p.key ? { ...x, upload: u } : x))))
        .catch((err) => setFiles((cur) => cur.map((x) => (x.key === p.key ? { ...x, error: (err as Error).message } : x))));
    }
  };

  const single = agent === 'claude' || agent === 'codex' ? agent : null;
  const modelFor = single ? models[single] ?? 'default' : 'default';
  const uploading = files.some((f) => !f.upload && !f.error);

  const send = async () => {
    const t = text.trim();
    if (!t || sending || running || uploading) return;
    setSending(true);
    const body = {
      text: t,
      agent,
      model: single && modelFor !== 'default' ? modelFor : undefined,
      effort: effort === 'auto' ? undefined : effort,
      attachments: files.filter((f) => f.upload).map((f) => f.upload!.id),
    };
    try {
      const r = conversationId
        ? await post<{ conversation: { id: string } }>(`/api/conversations/${conversationId}/messages`, body)
        : await post<{ conversation: { id: string } }>('/api/conversations', body);
      setText('');
      setFiles([]);
      onSent(r.conversation.id);
    } catch (err) {
      toastError(err);
    } finally {
      setSending(false);
      box.current?.focus();
    }
  };

  const modelOptions = single ? agents?.[single]?.models ?? [] : [];

  return (
    <div
      className={`composer${dragging ? ' dragging' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (e.dataTransfer.files.length) add(e.dataTransfer.files);
      }}
    >
      <div className="composer-panel">
      {files.length ? (
        <ul className="composer-files" aria-label="Attached files">
          {files.map((f) => (
            <li key={f.key} className={`file-chip${f.error ? ' error' : ''}`} title={f.error ?? `${f.file.name} · ${bytes(f.file.size)}`}>
              {f.file.type.startsWith('image/') ? <ImageIcon size={14} strokeWidth={1.5} /> : <FileText size={14} strokeWidth={1.5} />}
              <span className="file-chip-name">{f.file.name || 'Pasted image'}</span>
              <span className="file-chip-meta">{f.error ? 'Failed' : f.upload ? bytes(f.file.size) : 'Uploading…'}</span>
              <button className="file-chip-x" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x.key !== f.key))}>
                <X size={12} strokeWidth={1.5} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor="ask-input" className="sr-only">
        Message
      </label>
      <textarea
        id="ask-input"
        ref={box}
        rows={1}
        value={text}
        placeholder={placeholder ?? 'Ask anything, or describe a task'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
        onPaste={(e) => {
          const pasted = [...e.clipboardData.files];
          if (pasted.length) {
            e.preventDefault();
            add(pasted);
          }
        }}
      />
      <div className="composer-bar">
        <input ref={picker} type="file" multiple hidden onChange={(e) => (e.target.files ? add(e.target.files) : undefined, (e.target.value = ''))} />
        <button className="btn ghost sm icon" aria-label="Attach files" title="Attach files (or drop / paste them)" onClick={() => picker.current?.click()}>
          <Paperclip size={16} strokeWidth={1.5} />
        </button>
        <div className="segmented composer-agents" role="group" aria-label="Agent">
          {AGENTS.map((a) => (
            <button key={a.value} aria-pressed={agent === a.value} title={a.hint} onClick={() => setAgent(a.value)}>
              {a.label}
            </button>
          ))}
        </div>
        {single ? (
          <select className="select composer-select" aria-label={`${agentName(single)} model`} value={modelFor} onChange={(e) => setModels({ ...models, [single]: e.target.value })}>
            {single === 'codex' ? <option value="default">Codex default</option> : null}
            {modelOptions.map((m) => (
              <option key={m.value} value={m.value} title={m.description}>
                {m.label}
              </option>
            ))}
          </select>
        ) : null}
        <select className="select composer-select" aria-label="Effort" value={effort} onChange={(e) => setEffort(e.target.value as EffortChoice)}>
          {EFFORTS.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
        <span className="composer-spacer" />
        <MicButton onText={(t) => setText((cur) => (cur ? `${cur} ${t}` : t))} />
        {running ? (
          <button className="btn sm icon composer-send" aria-label="Stop" title="Stop the answer" onClick={onStop}>
            <Square size={14} strokeWidth={2} />
          </button>
        ) : (
          <button className="btn primary sm icon composer-send" aria-label="Send" title="Send (Enter)" disabled={!text.trim() || sending || uploading} onClick={() => void send()}>
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        )}
      </div>
      </div>
      <div className="composer-route" aria-live="polite">
        {uploading ? 'Uploading files…' : route ?? 'Enter to send · Shift+Enter for a new line · drop or paste files'}
      </div>
    </div>
  );
}
