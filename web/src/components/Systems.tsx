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

function Arc({ r, pct, color, width, label }: { r: number; pct: number; color: string; width: number; label: string }) {
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct));
  return (
    <g>
      <circle className="ring-track" cx="74" cy="74" r={r} fill="none" strokeWidth={width} opacity={0.6} />
      <circle
        cx="74"
        cy="74"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeLinecap="round"
        strokeDasharray={`${(c * p) / 100} ${c}`}
        transform="rotate(-90 74 74)"
        style={{ filter: `drop-shadow(0 0 4px ${color})`, transition: 'stroke-dasharray 400ms cubic-bezier(.2,.8,.2,1)' }}
      >
        <title>{`${label}: ${Math.round(p)}%`}</title>
      </circle>
    </g>
  );
}

/** Arc-reactor gauge: outer pair = Claude (5 h, weekly), inner pair = Codex. Centre = active runs. */
export function Reactor({ usage, active }: { usage: UsageState | null; active: number }) {
  const pct = (w: { usedPercent: number } | null | undefined) => w?.usedPercent ?? 0;
  return (
    <svg className="reactor" viewBox="0 0 148 148" role="img" aria-label={`Plan usage reactor: ${active} active runs`}>
      <circle className="spin-slow" cx="74" cy="74" r="71" fill="none" stroke="var(--hud-tick)" strokeWidth="1" strokeDasharray="2 6" />
      <Arc r={62} width={4} pct={pct(usage?.claude.five_hour)} color="var(--agent-claude)" label="Claude 5 h" />
      <Arc r={55} width={2} pct={pct(usage?.claude.weekly)} color="var(--agent-claude)" label="Claude weekly" />
      <Arc r={46} width={4} pct={pct(usage?.codex.five_hour)} color="var(--agent-codex)" label="Codex 5 h" />
      <Arc r={39} width={2} pct={pct(usage?.codex.weekly)} color="var(--agent-codex)" label="Codex weekly" />
      <circle cx="74" cy="74" r="30" fill="var(--bg-sunken)" stroke="var(--accent-line)" strokeWidth="1" />
      <circle cx="74" cy="74" r="30" fill="none" stroke="var(--accent)" strokeWidth="1" opacity={active ? 0.9 : 0.25} style={{ filter: active ? 'drop-shadow(0 0 6px var(--accent))' : undefined }} />
      <text x="74" y="76" textAnchor="middle" fontSize="20" fontWeight="500">
        {active}
      </text>
      <text x="74" y="90" textAnchor="middle" fontSize="7" letterSpacing="1.4" style={{ fill: 'var(--text-faint)' }}>
        ACTIVE
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
      <Reactor usage={u ?? null} active={summary.data?.active.length ?? 0} />
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
          <span className="v" style={{ fontSize: 16, lineHeight: '24px' }}>{next ? new Date(next.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
          <span className="d">{next ? `${next.name} · ${relTime(next.at)}` : 'none today'}</span>
        </Link>
      </div>
    </div>
  );
}
