import { useApi } from '../lib/hooks.ts';
import { relTime } from '../lib/format.ts';
import type { UsageState } from '../lib/types.ts';
import type { UsageResponse } from './UsageMeters.tsx';
import { Link } from './ui.tsx';

interface Summary {
  counts: Record<string, number>;
  approvals: number;
  active: Array<{ taskId: string }>;
}

const C = 76;

function Arc({ r, pct, color, width, label }: { r: number; pct: number; color: string; width: number; label: string }) {
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <g>
      <circle className="ring-track" cx={C} cy={C} r={r} fill="none" strokeWidth={width} opacity={0.7} />
      <circle className="arc" cx={C} cy={C} r={r} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} transform={`rotate(-90 ${C} ${C})`}>
        <title>{`${label}: ${Math.round(p)}%`}</title>
      </circle>
    </g>
  );
}

/** Instrument dial: 60 ticks, a longer one every 5. It turns slowly only while an agent is running. */
function Dial() {
  return (
    <g className="dial-ring">
      {Array.from({ length: 60 }, (_, i) => {
        const major = i % 5 === 0;
        const a = (i * Math.PI) / 30;
        const r1 = major ? 69 : 71;
        return <line key={i} className={`dial${major ? ' dial-major' : ''}`} x1={C + r1 * Math.sin(a)} y1={C - r1 * Math.cos(a)} x2={C + 75 * Math.sin(a)} y2={C - 75 * Math.cos(a)} strokeWidth={1} />;
      })}
    </g>
  );
}

/** Reactor core: outer pair = Claude (5 h, weekly), inner pair = Codex. Centre = running agents. */
export function Reactor({ usage, active }: { usage: UsageState | null; active: number }) {
  const pct = (w: { usedPercent: number } | null | undefined) => w?.usedPercent ?? 0;
  return (
    <svg className={`reactor${active ? ' live' : ''}`} viewBox="0 0 152 152" role="img" aria-label={`${active} agents running. Claude 5-hour ${Math.round(pct(usage?.claude.five_hour))}%, Codex 5-hour ${Math.round(pct(usage?.codex.five_hour))}%`}>
      <Dial />
      <Arc r={61} width={4} pct={pct(usage?.claude.five_hour)} color="var(--agent-claude)" label="Claude 5 hours" />
      <Arc r={55} width={2} pct={pct(usage?.claude.weekly)} color="var(--agent-claude)" label="Claude weekly" />
      <Arc r={46} width={4} pct={pct(usage?.codex.five_hour)} color="var(--agent-codex)" label="Codex 5 hours" />
      <Arc r={40} width={2} pct={pct(usage?.codex.weekly)} color="var(--agent-codex)" label="Codex weekly" />
      <circle className="core" cx={C} cy={C} r={31} strokeWidth={1} />
      <text className="core-count" x={C} y={C + 4} textAnchor="middle" fontSize="22" fontWeight="400">
        {active}
      </text>
      <text x={C} y={C + 17} textAnchor="middle" fontSize="8" style={{ fill: 'var(--text-faint)' }}>
        running
      </text>
    </svg>
  );
}

export function Systems() {
  const summary = useApi<Summary>('/api/summary', ['task.*', 'approval.*', 'run.started', 'run.finished']);
  const usage = useApi<UsageResponse>('/api/usage?days=1', ['usage.updated']);
  const today = useApi<{ upcoming: Array<{ name: string; at: string }> }>('/api/schedules/today', ['schedule.*']);
  const c = summary.data?.counts ?? {};
  const needs = (summary.data?.approvals ?? 0) + Math.max(0, (c.needs_you ?? 0) - (summary.data?.approvals ?? 0));
  const next = today.data?.upcoming[0];
  const u = usage.data?.current;
  const worst = u ? Math.max(u.claude.five_hour?.usedPercent ?? 0, u.codex.five_hour?.usedPercent ?? 0) : null;
  return (
    <div className="systems">
      <div className="reactor-wrap">
        <Reactor usage={u ?? null} active={summary.data?.active.length ?? 0} />
        <div className="reactor-legend" aria-hidden>
          <span><i style={{ background: 'var(--agent-claude)' }} />Claude</span>
          <span><i style={{ background: 'var(--agent-codex)' }} />Codex</span>
        </div>
      </div>
      <div className="telemetry" role="list" aria-label="System status">
        <Link to="/board" role="listitem">
          <span className="k">Running</span>
          <span className={`v${c.running ? ' live' : ''}`}>{summary.data ? c.running ?? 0 : '–'}</span>
          <span className="d">{c.queued ? `${c.queued} queued` : 'queue clear'}</span>
        </Link>
        <Link to="/approvals" role="listitem">
          <span className="k">Needs you</span>
          <span className={`v${needs ? ' warn' : ''}`}>{summary.data ? needs : '–'}</span>
          <span className="d">{summary.data?.approvals ? `${summary.data.approvals} approval${summary.data.approvals === 1 ? '' : 's'}` : 'nothing pending'}</span>
        </Link>
        <Link to="/usage" role="listitem">
          <span className="k">Plan load</span>
          <span className={`v${worst !== null && worst >= (usage.data?.fallbackAtPercent ?? 85) ? ' warn' : ''}`}>{worst === null ? '–' : `${Math.round(worst)}%`}</span>
          <span className="d">highest 5-hour window</span>
        </Link>
        <Link to="/schedules" role="listitem">
          <span className="k">Next routine</span>
          <span className="v small">{next ? new Date(next.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
          <span className="d">{next ? `${next.name} · ${relTime(next.at)}` : 'none today'}</span>
        </Link>
      </div>
    </div>
  );
}
