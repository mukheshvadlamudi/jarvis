import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { AgentStatus } from '../lib/ask.ts';
import { post } from '../lib/api.ts';
import { resetsIn } from '../lib/format.ts';
import type { AgentId, UsageWindow } from '../lib/types.ts';
import { Link } from './ui.tsx';

const STATE_COLOR: Record<AgentStatus['state'], string> = {
  ready: 'var(--success)',
  busy: 'var(--accent)',
  signed_out: 'var(--danger)',
  limited: 'var(--warning)',
};

function Window({ label, w, threshold }: { label: string; w: UsageWindow | null; threshold: number }) {
  const pct = w ? Math.round(w.usedPercent) : null;
  const tone = pct === null ? '' : pct >= threshold ? ' danger' : pct >= 70 ? ' warn' : '';
  return (
    <span className="agent-window" title={w?.resetsAt ? `Resets ${resetsIn(w.resetsAt)}` : pct === null ? 'Not reported yet' : undefined}>
      <span className="agent-window-label">{label}</span>
      <span className={`agent-window-bar${tone}`} aria-hidden>
        <span style={{ transform: `scaleX(${(pct ?? 0) / 100})` }} />
      </span>
      <span className="agent-window-pct">{pct === null ? '–' : `${pct}%`}</span>
    </span>
  );
}

/**
 * Both agents at a glance on Ask: signed in or not, what they are doing, real plan usage, and the
 * model each uses by default. Tapping a card picks that agent for the next message.
 */
export function AgentStrip({ agents, threshold, picked, onPick, onRefreshed }: {
  agents: Record<AgentId, AgentStatus> | null;
  threshold: number;
  picked: string;
  onPick: (a: AgentId) => void;
  onRefreshed: (a: Record<AgentId, AgentStatus>) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="agent-strip" role="list" aria-label="Agents">
      {(['claude', 'codex'] as const).map((id) => {
        const a = agents?.[id];
        const model = a?.models.find((m) => m.value === a.defaultModel)?.label ?? a?.defaultModel ?? '';
        return (
          <div key={id} role="listitem" className={`agent-card agent-${id}${picked === id ? ' picked' : ''}`}>
            <button className="agent-card-main" onClick={() => onPick(id)} aria-pressed={picked === id} title={`Ask ${a?.label ?? id} next`}>
              <span className="agent-card-head">
                <span className={`dot${a?.state === 'busy' ? ' live' : ''}`} style={{ color: a ? STATE_COLOR[a.state] : 'var(--text-faint)' }} />
                <span className="agent-card-name">{a?.label ?? (id === 'claude' ? 'Claude' : 'Codex')}</span>
                <span className="agent-card-model mono">{model.replace(/ \(recommended\)$/i, '')}</span>
              </span>
              <span className="agent-card-detail">{a ? (a.state === 'busy' ? `Working on ${a.detail}` : a.detail) : 'Checking…'}</span>
            </button>
            <span className="agent-card-usage">
              <Window label="5 h" w={a?.usage.five_hour ?? null} threshold={threshold} />
              <Window label="Week" w={a?.usage.weekly ?? null} threshold={threshold} />
            </span>
            {a?.state === 'signed_out' ? (
              <Link to="/setup" className="agent-card-fix">Sign in</Link>
            ) : null}
          </div>
        );
      })}
      <button
        className="btn ghost sm icon agent-refresh"
        aria-label="Refresh agent status"
        title="Re-read real usage and models"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            onRefreshed((await post<{ agents: Record<AgentId, AgentStatus> }>('/api/agents/refresh')).agents);
          } finally {
            setBusy(false);
          }
        }}
      >
        <RefreshCw size={14} strokeWidth={1.5} className={busy ? 'spin' : undefined} />
      </button>
    </div>
  );
}
