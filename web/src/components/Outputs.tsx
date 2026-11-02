import { Copy, Download, FileArchive, FileAudio, FileCode, FileImage, FileSpreadsheet, FileText, FileVideo, FolderOpen, Library, File as FileIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { getToken, post } from '../lib/api.ts';
import { bytes, relTime } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import { parseCsv } from '../lib/csv.ts';
import { Markdown } from '../lib/markdown.tsx';
import { toast, toastError } from '../lib/toast.ts';
import { Empty, Sheet, Skeleton } from './ui.tsx';

type Kind = 'markdown' | 'text' | 'code' | 'csv' | 'json' | 'html' | 'image' | 'pdf' | 'office' | 'audio' | 'video' | 'archive' | 'binary';
export interface OutputFile {
  folder: number;
  path: string;
  name: string;
  size: number;
  mtime: string;
  kind: Kind;
  changed: boolean;
}

const ICON: Record<Kind, LucideIcon> = {
  markdown: FileText,
  text: FileText,
  code: FileCode,
  json: FileCode,
  html: FileCode,
  csv: FileSpreadsheet,
  office: FileSpreadsheet,
  image: FileImage,
  pdf: FileText,
  audio: FileAudio,
  video: FileVideo,
  archive: FileArchive,
  binary: FileIcon,
};
const TEXTY = new Set<Kind>(['markdown', 'text', 'code', 'json', 'csv']);
const PREVIEW_LIMIT = 1_500_000;

export function rawUrl(taskId: string, f: Pick<OutputFile, 'folder' | 'path'>, download = false): string {
  const q = new URLSearchParams({ folder: String(f.folder), path: f.path });
  if (download) q.set('download', '1');
  const t = getToken();
  if (t) q.set('token', t);
  return `/api/tasks/${taskId}/outputs/raw?${q}`;
}

function CsvTable({ text }: { text: string }) {
  const rows = useMemo(() => parseCsv(text).slice(0, 501), [text]);
  if (!rows.length) return <p className="faint">Empty file.</p>;
  const [head, ...body] = rows;
  return (
    <div className="out-table-wrap">
      <table className="out-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className={/^-?[\d.,]+%?$/.test(c.trim()) ? 'num mono' : undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 500 ? <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>First 500 rows — download for the rest.</p> : null}
    </div>
  );
}

function Preview({ taskId, f }: { taskId: string; f: OutputFile }) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const url = rawUrl(taskId, f);
  useEffect(() => {
    if (!TEXTY.has(f.kind) || f.size > PREVIEW_LIMIT) return;
    let cancelled = false;
    setText(null);
    fetch(url)
      .then(async (r) => (r.ok ? r.text() : Promise.reject(new Error(`Could not load the file (${r.status}).`))))
      .then((t) => !cancelled && setText(t))
      .catch((e: Error) => !cancelled && setErr(e.message));
    return () => {
      cancelled = true;
    };
  }, [url, f.kind, f.size]);

  if (TEXTY.has(f.kind) && f.size > PREVIEW_LIMIT) return <Empty title="Too large to preview here">Download it to open it in another app.</Empty>;
  if (err) return <p className="faint">{err}</p>;
  if (TEXTY.has(f.kind) && text === null) return <Skeleton h={160} />;
  switch (f.kind) {
    case 'markdown':
      return (
        <div className="prose">
          <Markdown source={text ?? ''} />
        </div>
      );
    case 'csv':
      return <CsvTable text={text ?? ''} />;
    case 'json': {
      let pretty = text ?? '';
      try {
        pretty = JSON.stringify(JSON.parse(pretty), null, 2);
      } catch {
        // JSONL or invalid: show as-is
      }
      return <pre className="code out-code">{pretty}</pre>;
    }
    case 'text':
    case 'code':
      return <pre className="code out-code">{text}</pre>;
    case 'image':
      return <img className="out-media" src={url} alt={f.name} />;
    case 'pdf':
      return <iframe className="out-frame" src={url} title={f.name} />;
    case 'html':
      return <iframe className="out-frame" src={url} title={f.name} sandbox="" />;
    case 'audio':
      return <audio controls src={url} style={{ width: '100%' }} />;
    case 'video':
      return <video controls src={url} className="out-media" />;
    default:
      return (
        <Empty title={f.kind === 'office' ? 'Office document' : 'No preview for this file type.'}>
          {f.kind === 'office' ? 'Download it to open in Word, Excel, PowerPoint or Numbers.' : 'Download it to open it in another app.'}
        </Empty>
      );
  }
}

/** Files the agents produced for a task — the same view for Claude and Codex output. */
export function OutputsPanel({ taskId, live }: { taskId: string; live: boolean }) {
  const res = useApi<{ folders: string[]; files: OutputFile[] }>(`/api/tasks/${taskId}/outputs`, ['run.finished']);
  const [open, setOpen] = useState<OutputFile | null>(null);
  const [target, setTarget] = useState('Jarvis/Outputs');
  const [saving, setSaving] = useState(false);
  const files = res.data?.files ?? [];
  const shown = files.slice(0, 40);

  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => res.reload(), 8000);
    return () => window.clearInterval(t);
  }, [live, res.reload]);

  const save = async () => {
    if (!open) return;
    setSaving(true);
    try {
      const r = await post<{ saved: string }>(`/api/tasks/${taskId}/outputs/save`, { folder: open.folder, path: open.path, target });
      toast(`Saved to the vault: ${r.saved}`, { kind: 'success' });
    } catch (err) {
      toastError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Outputs</h2>
        {files.length ? <span className="count">{files.length}</span> : null}
      </div>
      {!res.data && res.loading ? (
        <div className="panel-body">
          <Skeleton w="60%" />
        </div>
      ) : !files.length ? (
        <div className="panel-body">
          <p className="faint" style={{ fontSize: 12 }}>{live ? 'Files the agent writes show up here.' : 'No files in the working folder.'}</p>
        </div>
      ) : (
        <ul className="list">
          {shown.map((f) => {
            const Icon = ICON[f.kind];
            return (
              <li key={`${f.folder}:${f.path}`}>
                <button className="row" onClick={() => setOpen(f)} title={f.path}>
                  <Icon size={14} strokeWidth={1.5} style={{ flex: 'none', color: f.changed ? 'var(--accent-text)' : 'var(--text-faint)' }} />
                  <span className="title mono" style={{ fontSize: 12, fontWeight: 400 }}>
                    {f.path}
                  </span>
                  <span className="time num">{bytes(f.size)}</span>
                </button>
              </li>
            );
          })}
          {files.length > shown.length ? <li className="faint" style={{ fontSize: 12, padding: '8px 16px' }}>+{files.length - shown.length} more in the folder</li> : null}
        </ul>
      )}
      {open ? (
        <Sheet
          wide
          title={<span className="mono" style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{open.path}</span>}
          onClose={() => setOpen(null)}
          footer={
            <div className="out-foot">
              <span className="faint" style={{ fontSize: 12 }}>
                {bytes(open.size)} · {relTime(open.mtime)}
              </span>
              <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginLeft: 'auto' }}>
                <button
                  className="btn ghost sm"
                  title={res.data?.folders[open.folder]}
                  onClick={() => {
                    const p = `${res.data?.folders[open.folder] ?? ''}/${open.path}`;
                    void navigator.clipboard?.writeText(p).then(() => toast('Path copied', { kind: 'success' }));
                  }}
                >
                  <Copy size={14} strokeWidth={1.5} /> Copy path
                </button>
                <input className="input mono" aria-label="Vault folder" value={target} onChange={(e) => setTarget(e.target.value)} style={{ width: 150, height: 28, fontSize: 12 }} />
                <button className="btn ghost sm" disabled={saving} onClick={() => void save()}>
                  <Library size={14} strokeWidth={1.5} /> Save to vault
                </button>
                <a className="btn primary sm" href={rawUrl(taskId, open, true)} download={open.name}>
                  <Download size={14} strokeWidth={1.5} /> Download
                </a>
              </span>
            </div>
          }
        >
          <Preview taskId={taskId} f={open} />
          {res.data && res.data.folders.length ? (
            <p className="faint" style={{ fontSize: 11, marginTop: 12, display: 'flex', gap: 6, alignItems: 'center', overflowWrap: 'anywhere' }}>
              <FolderOpen size={12} strokeWidth={1.5} /> {res.data.folders[open.folder]}
            </p>
          ) : null}
        </Sheet>
      ) : null}
    </div>
  );
}

