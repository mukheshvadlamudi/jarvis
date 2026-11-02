import { useRef, useState } from 'react';
import { tokens } from '../lib/format.ts';

export interface Series {
  key: string;
  label: string;
  color: string;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** Grouped bars per category (e.g. tokens per day per agent). */
export function BarChart({ data, series, xLabel, height = 180, format = tokens }: { data: Array<Record<string, number | string>>; series: Series[]; xLabel: (d: Record<string, number | string>) => string; height?: number; format?: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const W = 640;
  const H = height;
  const pad = { l: 44, r: 8, t: 8, b: 22 };
  const max = niceMax(Math.max(1, ...data.flatMap((d) => series.map((s) => Number(d[s.key]) || 0))));
  const bw = (W - pad.l - pad.r) / Math.max(1, data.length);
  const inner = Math.min(10, (bw - 6) / series.length);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const every = Math.ceil(data.length / 7);
  return (
    <div ref={wrap} style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Bar chart">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="axis" x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} strokeDasharray={f === 0 ? undefined : '2 4'} />
            <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end">
              {format(max * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          const x0 = pad.l + i * bw + (bw - inner * series.length) / 2;
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + i * bw} y={pad.t} width={bw} height={H - pad.t - pad.b} fill={hover === i ? 'var(--bg-hover)' : 'transparent'} />
              {series.map((s, j) => {
                const v = Number(d[s.key]) || 0;
                return <rect key={s.key} x={x0 + j * inner} y={y(v)} width={Math.max(1, inner - 2)} height={Math.max(0, y(0) - y(v))} rx={1.5} fill={s.color} />;
              })}
              {i % every === 0 ? (
                <text x={pad.l + i * bw + bw / 2} y={H - 6} textAnchor="middle">
                  {xLabel(d)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] ? (
        <div className="chart-tip" style={{ left: `min(calc(${((pad.l + hover * bw + bw / 2) / W) * 100}% + 8px), calc(100% - 150px))`, top: 0 }}>
          <div className="faint">{xLabel(data[hover])}</div>
          {series.map((s) => (
            <div key={s.key}>
              <span className="swatch" style={{ background: s.color }} />
              {s.label} {format(Number(data[hover][s.key]) || 0)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Thin step lines of percentage over time (5-hour window history). */
export function LineChart({ lines, height = 160, threshold }: { lines: Array<Series & { points: Array<{ t: number; v: number }> }>; height?: number; threshold?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = height;
  const pad = { l: 36, r: 8, t: 8, b: 22 };
  const all = lines.flatMap((l) => l.points);
  if (!all.length) return <p className="faint" style={{ fontSize: 12 }}>No history yet — readings appear after the first runs.</p>;
  const t0 = Math.min(...all.map((p) => p.t));
  const t1 = Math.max(...all.map((p) => p.t), t0 + 1);
  const x = (t: number) => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / 100);
  const days = Math.max(1, Math.round((t1 - t0) / 86400_000));
  const ticks = Array.from({ length: days + 1 }, (_, i) => t0 + i * 86400_000).filter((t) => t <= t1);
  const hoverT = hover === null ? null : t0 + ((hover - pad.l) / (W - pad.l - pad.r)) * (t1 - t0);
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => setHover(null)}>
      <svg
        className="chart"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Usage history"
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setHover(((e.clientX - r.left) / r.width) * W);
        }}
      >
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line className="axis" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} strokeDasharray={v === 0 ? undefined : '2 4'} />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end">
              {v}%
            </text>
          </g>
        ))}
        {threshold ? <line x1={pad.l} x2={W - pad.r} y1={y(threshold)} y2={y(threshold)} stroke="var(--danger)" strokeOpacity={0.5} strokeDasharray="4 3" /> : null}
        {ticks.map((t) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor="middle">
            {new Date(t).toLocaleDateString(undefined, { weekday: 'short' })}
          </text>
        ))}
        {lines.map((l) => (
          <polyline key={l.key} fill="none" stroke={l.color} strokeWidth={1.5} strokeLinejoin="round" points={l.points.map((p) => `${x(p.t)},${y(p.v)}`).join(' ')} />
        ))}
        {hover !== null && hover > pad.l ? <line x1={hover} x2={hover} y1={pad.t} y2={H - pad.b} stroke="var(--border-strong)" /> : null}
      </svg>
      {hover !== null && hoverT !== null && hover > pad.l ? (
        <div className="chart-tip" style={{ left: `min(calc(${(hover / W) * 100}% + 8px), calc(100% - 150px))`, top: 0 }}>
          <div className="faint">{new Date(hoverT).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
          {lines.map((l) => {
            const p = [...l.points].reverse().find((pt) => pt.t <= hoverT) ?? l.points[0];
            return (
              <div key={l.key}>
                <span className="swatch" style={{ background: l.color }} />
                {l.label} {Math.round(p.v)}%
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
