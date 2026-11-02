import { BarChart, LineChart } from '../components/Charts.tsx';
import type { UsageResponse } from '../components/UsageMeters.tsx';
import { UsageMeters } from '../components/UsageMeters.tsx';
import { AgentBadge, Empty, ErrorBox, Link, PageHead, Segmented, Skeleton, StatusLabel } from '../components/ui.tsx';
import { useState } from 'react';
import { relTime, TYPE_LABEL, tokens } from '../lib/format.ts';
import { useApi } from '../lib/hooks.ts';
import { setQuery, useLocation } from '../lib/router.ts';

const SERIES = [
  { key: 'claude', label: 'Claude', color: 'var(--agent-claude)' },
  { key: 'codex', label: 'Codex', color: 'var(--agent-codex)' },
];

export default function Usage() {
  const { query } = useLocation();
  const days = Number(query.get('days') ?? 14);
  const res = useApi<UsageResponse>(`/api/usage?days=${days}`, ['usage.updated', 'run.finished']);
  const d = res.data;
  const [allRoutes, setAllRoutes] = useState(false);

  return (
    <div className="page">
      <PageHead title="Usage" sub="Plan windows from Codex session logs and Claude’s own rate-limit events">
        <Segmented
          label="Range"
          value={String(days)}
          onChange={(v) => setQuery({ days: v === '14' ? null : v })}
          options={[
            { value: '7', label: '7 days' },
            { value: '14', label: '14 days' },
            { value: '30', label: '30 days' },
          ]}
        />
      </PageHead>
      {res.error ? <ErrorBox error={res.error} onRetry={res.reload} /> : null}

      <div className="grid-2">
        <section className="panel">
          <div className="panel-head">
            <h2>Plan windows</h2>
            <span className="right faint" style={{ fontSize: 12 }}>
              Router switches agents at {d?.fallbackAtPercent ?? 85}%
            </span>
          </div>
          <div className="panel-body">
            <UsageMeters data={d ?? null} />
            {d && (d.current.claude.five_hour?.estimate || d.current.claude.weekly?.estimate) ? (
              <p className="faint" style={{ fontSize: 12, marginTop: 12 }}>
                Claude windows marked “estimate” are computed from local transcripts against soft caps of {tokens(d.softCaps.fiveHourTokens)} (5 h) and {tokens(d.softCaps.weeklyTokens)} (weekly) — adjust them in{' '}
                <Link to="/settings" className="muted">
                  Settings
                </Link>
                . Live runs replace estimates with Claude’s own readings.
              </p>
            ) : null}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>5-hour window, last 7 days</h2>
            <span className="right legend">
              {SERIES.map((s) => (
                <span key={s.key}>
                  <span className="swatch" style={{ background: s.color, margin: 0 }} />
                  {s.label}
                </span>
              ))}
            </span>
          </div>
          <div className="panel-body">
            {d ? (
              <LineChart
                height={236}
                threshold={d.fallbackAtPercent}
                lines={SERIES.map((s) => ({ ...s, points: d.history[s.key as 'claude' | 'codex'].map((p) => ({ t: Date.parse(p.ts), v: p.used_percent })) }))}
              />
            ) : (
              <Skeleton h={150} />
            )}
          </div>
        </section>
      </div>

      <div className="grid-3" style={{ marginTop: 24 }}>
        <div className="panel panel-body stat">
          <span className="label">Runs ({days} days)</span>
          <span className="value">{d ? d.totals.runs : '—'}</span>
        </div>
        <div className="panel panel-body stat">
          <span className="label">Tokens in + out</span>
          <span className="value">{d ? tokens(d.totals.tokens) : '—'}</span>
        </div>
        <div className="panel panel-body stat">
          <span className="label">Tool calls</span>
          <span className="value">{d ? d.totals.toolCalls.toLocaleString() : '—'}</span>
        </div>
      </div>

      <div className="grid-2" style={{ marginTop: 24 }}>
        <section className="panel">
          <div className="panel-head">
            <h2>Tokens per day</h2>
          </div>
          <div className="panel-body">
            {d ? (
              d.daily.some((x) => x.claude + x.codex > 0) ? (
                <BarChart data={d.daily as unknown as Array<Record<string, number | string>>} series={SERIES} xLabel={(x) => new Date(`${x.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} />
              ) : (
                <Empty title="No runs in this range.">Token totals come from each run’s final usage event.</Empty>
              )
            ) : (
              <Skeleton h={170} />
            )}
          </div>
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2>By task type</h2>
          </div>
          <div className="panel-body">
            {d ? (
              d.byType.length ? (
                <BarChart data={d.byType as unknown as Array<Record<string, number | string>>} series={SERIES} xLabel={(x) => TYPE_LABEL[String(x.type)] ?? String(x.type)} />
              ) : (
                <Empty title="No runs in this range." />
              )
            ) : (
              <Skeleton h={170} />
            )}
          </div>
        </section>
      </div>

      <section className="panel" style={{ marginTop: 24 }}>
        <div className="panel-head">
          <h2>Routing decisions</h2>
          <span className="count">{d?.routing.length ?? ''}</span>
        </div>
        {!d ? (
          <div className="panel-body">
            <Skeleton />
          </div>
        ) : !d.routing.length ? (
          <Empty title="No runs yet.">Every run records why it went to Claude or Codex — fallbacks show up here.</Empty>
        ) : (
          <ul className="list">
            {(allRoutes ? d.routing : d.routing.slice(0, 12)).map((r) => (
              <li key={r.run_id}>
                <Link to={`/runs/${r.run_id}`} className="row">
                  <AgentBadge agent={r.agent as 'claude' | 'codex'} />
                  <div className="row-stack">
                    <span className="title">{r.title}</span>
                    <span className="sub mono" style={{ fontSize: 12, color: r.route_reason?.startsWith('fallback') ? 'var(--warning)' : undefined }}>
                      {r.route_reason ?? '—'}
                    </span>
                  </div>
                  <span className="meta">
                    <span className="hide-sm">
                      <StatusLabel status={r.status} />
                    </span>
                    <span className="mono hide-sm">{tokens(r.tokens)}</span>
                    <span className="time">{relTime(r.started_at)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {d && d.routing.length > 12 && !allRoutes ? (
          <div style={{ padding: 8, borderTop: '1px solid var(--border)' }}>
            <button className="btn ghost sm" onClick={() => setAllRoutes(true)}>
              Show all {d.routing.length}
            </button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
