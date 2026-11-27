import { useLayoutEffect, useRef, useState } from 'react';
import type { DayPoint } from '../lib/api.ts';
import { dayLabel, num } from '../lib/format.ts';

/* Chart conventions (see dataviz method): thin marks, 2px surface gaps between stacked
   segments, 4px rounded data-ends anchored to the baseline, recessive grid, hover tooltip,
   legend always present for multi-series, text in text tokens. */

export const VERDICT_SERIES = [
  // stack order from the baseline; adjacent pairs validated for CVD separation
  { key: 'block', label: 'Blocked', color: 'var(--m-block)' },
  { key: 'overridden', label: 'Overridden', color: 'var(--m-over)' },
  { key: 'warn', label: 'Warning', color: 'var(--m-warn)' },
  { key: 'pass', label: 'Passed', color: 'var(--m-pass)' },
] as const;

type SeriesKey = (typeof VERDICT_SERIES)[number]['key'];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 4) return { max: 4, step: 1 };
  const raw = v / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
  return { max: Math.ceil(v / step) * step, step };
}

/** Rect with only the top corners rounded (data-end away from the baseline). */
function topRounded(x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function Legend({ items }: { items: ReadonlyArray<{ label: string; color: string; value?: string }> }) {
  return (
    <div className="legend">
      {items.map(i => (
        <span key={i.label}><i style={{ background: i.color }} />{i.label}{i.value && <b style={{ marginLeft: 8, color: 'var(--text)', fontWeight: 600 }}>{i.value}</b>}</span>
      ))}
    </div>
  );
}

export function StackedBars({ data, height = 240, onSelect }: { data: DayPoint[]; height?: number; onSelect?: (d: DayPoint) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 34, r: 8, t: 10, b: 26 };
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const totals = data.map(d => d.pass + d.warn + d.block + d.overridden);
  const { max, step } = niceMax(Math.max(1, ...totals));
  const band = data.length ? iw / data.length : 0;
  const bw = Math.max(3, Math.min(22, band * 0.64));
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const every = Math.max(1, Math.ceil(data.length / 8));
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);

  const hovered = hover !== null ? data[hover] : null;
  const tipX = hover !== null ? pad.l + band * hover + band / 2 : 0;
  const tipY = hover !== null ? y(totals[hover]) - 10 : 0;

  return (
    <div ref={ref} style={{ position: 'relative', height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Checks per day by verdict">
          {ticks.map(t => (
            <g key={t}>
              <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} stroke="var(--grid)" strokeDasharray={t === 0 ? undefined : '3 4'} />
              <text x={pad.l - 8} y={y(t)} dy="0.35em" textAnchor="end" fontSize="12" fill="var(--text-3)" className="tnum">{num(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.l + band * i + (band - bw) / 2;
            let acc = 0;
            const segs = VERDICT_SERIES.map(s => ({ ...s, v: d[s.key as SeriesKey] })).filter(s => s.v > 0);
            const dim = hover !== null && hover !== i;
            return (
              <g key={d.date} opacity={dim ? 0.38 : 1} style={{ transition: 'opacity .15s' }}>
                {segs.map((s, j) => {
                  const y0 = y(acc);
                  acc += s.v;
                  const y1 = y(acc);
                  const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked fills
                  const h = Math.max(1, y0 - y1 - gap);
                  const top = j === segs.length - 1;
                  return top
                    ? <path key={s.key} d={topRounded(x, y1, bw, h, 4)} fill={s.color} />
                    : <rect key={s.key} x={x} y={y1 + 0} width={bw} height={h} fill={s.color} />;
                })}
              </g>
            );
          })}
          {data.map((d, i) => (data.length - 1 - i) % every === 0 && (
            <text key={d.date} x={pad.l + band * i + band / 2} y={height - 8} textAnchor="middle" fontSize="12" fill="var(--text-3)">
              {dayLabel(d.date)}
            </text>
          ))}
          {data.map((d, i) => (
            <rect
              key={`hit-${d.date}`}
              x={pad.l + band * i}
              y={pad.t}
              width={band}
              height={ih}
              fill="transparent"
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onMouseEnter={() => setHover(i)}
              onClick={() => onSelect?.(d)}
            />
          ))}
        </svg>
      )}
      {hovered && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(tipX, 90), width - 90), top: Math.max(tipY, 70) }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>{dayLabel(hovered.date)}</div>
          {[...VERDICT_SERIES].reverse().map(s => (
            <div key={s.key} className="row" style={{ justifyContent: 'space-between', gap: 16 }}>
              <span className="row" style={{ color: 'var(--text-2)' }}><i style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />{s.label}</span>
              <b className="tnum">{hovered[s.key as SeriesKey]}</b>
            </div>
          ))}
          <div className="divider" style={{ margin: '8px 0' }} />
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Total</span><b className="tnum">{totals[hover!]}</b></div>
        </div>
      )}
    </div>
  );
}

const ARM_COLORS = ['var(--m-info)', 'var(--m-brand)', 'var(--m-over)', 'var(--m-warn)'];

/** Exposure split between arms: one bar, 2px gaps, legend with counts below. */
export function ArmSplit({ arms }: { arms: Array<{ key: string; identities: number }> }) {
  const total = arms.reduce((n, a) => n + a.identities, 0) || 1;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="arms" role="img" aria-label={arms.map(a => `${a.key} ${a.identities}`).join(', ')}>
        {arms.map((a, i) => (
          <span key={a.key} style={{ width: `${(a.identities / total) * 100}%`, background: ARM_COLORS[i % ARM_COLORS.length] }} title={`${a.key}: ${num(a.identities)}`} />
        ))}
      </div>
      <Legend items={arms.map((a, i) => ({ label: a.key, color: ARM_COLORS[i % ARM_COLORS.length], value: num(a.identities) }))} />
    </div>
  );
}
