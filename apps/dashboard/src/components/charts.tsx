import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
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
        <span key={i.label}><i style={{ background: i.color }} />{i.label}{i.value && <b style={{ marginLeft: 6, color: 'var(--text)', fontWeight: 600 }}>{i.value}</b>}</span>
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
              <text x={pad.l - 8} y={y(t)} dy="0.35em" textAnchor="end" fontSize="11" fill="var(--text-3)" className="tnum">{num(t)}</text>
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
            <text key={d.date} x={pad.l + band * i + band / 2} y={height - 8} textAnchor="middle" fontSize="11" fill="var(--text-3)">
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
          <div style={{ fontWeight: 600, marginBottom: 6 }}>{dayLabel(hovered.date)}</div>
          {[...VERDICT_SERIES].reverse().map(s => (
            <div key={s.key} className="row" style={{ justifyContent: 'space-between', gap: 16 }}>
              <span className="row" style={{ color: 'var(--text-2)' }}><i style={{ width: 8, height: 8, borderRadius: 2, background: s.color, display: 'inline-block' }} />{s.label}</span>
              <b className="tnum">{hovered[s.key as SeriesKey]}</b>
            </div>
          ))}
          <div className="divider" style={{ margin: '6px 0' }} />
          <div className="row" style={{ justifyContent: 'space-between' }}><span className="muted">Total</span><b className="tnum">{totals[hover!]}</b></div>
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values, color = 'var(--m-brand)', height = 34 }: { values: number[]; color?: string; height?: number }) {
  const id = useId().replace(/:/g, '');
  const w = 120;
  const { line, area, last } = useMemo(() => {
    if (values.length < 2) return { line: '', area: '', last: null as null | [number, number] };
    const max = Math.max(1, ...values);
    const pts = values.map((v, i) => [(i / (values.length - 1)) * w, height - 3 - (v / max) * (height - 8)] as [number, number]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    return { line, area: `${line}L${w},${height}L0,${height}Z`, last: pts[pts.length - 1] };
  }, [values, height]);
  if (!line) return <div style={{ height }} />;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} aria-hidden="true" style={{ overflow: 'visible' }}>
      <defs>
        <linearGradient id={`sp${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.28" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sp${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      {last && <circle cx={last[0]} cy={last[1]} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />}
    </svg>
  );
}

export function Ring({ value, size = 52, stroke = 6, color = 'var(--m-pass)', label }: { value: number; size?: number; stroke?: number; color?: string; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${c * v} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dasharray .7s cubic-bezier(.2,.8,.2,1)' }}
      />
    </svg>
  );
}

const ARM_COLORS = ['var(--m-brand)', 'var(--brand-2)', 'var(--m-over)', 'var(--m-warn)'];

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

export function HBars({ rows, onSelect }: { rows: Array<{ key: string; label: string; value: number; color: string; hint?: string }>; onSelect?: (key: string) => void }) {
  const max = Math.max(1, ...rows.map(r => r.value));
  return (
    <div>
      {rows.map(r => (
        <div
          key={r.key}
          className="hbar"
          title={r.hint}
          style={{ cursor: onSelect ? 'pointer' : undefined }}
          onClick={() => onSelect?.(r.key)}
        >
          <span className="mono small" style={{ color: 'var(--text-2)' }}>{r.label}</span>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${(r.value / max) * 100}%`, background: r.color }} /></div>
          <span className="tnum small" style={{ textAlign: 'right', fontWeight: 600 }}>{num(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- template-style charts ---------- */

function niceStep(raw: number) {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? raw;
}

/** Grey bars with one highlighted (the latest, or the hovered one) and a value pill above it. */
export function BarRate({ bars, height = 176, format, tickFormat }: {
  bars: Array<{ label: string; value: number; detail?: string }>; height?: number; format: (v: number) => string; tickFormat?: (v: number, step: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, '');
  const act = hover ?? bars.length - 1;
  const pad = { l: 42, r: 4, t: 34, b: 24 };
  const iw = Math.max(0, width - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const maxV = Math.max(1e-6, ...bars.map(b => b.value));
  const step = niceStep((maxV * 1.1) / 4);
  const max = step * 4;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const band = bars.length ? iw / bars.length : 0;
  const bw = Math.max(8, Math.min(46, band * 0.58));
  const ticks = [0, 1, 2, 3, 4].map(i => i * step);
  const a = bars[act];
  const ax = pad.l + band * act + band / 2;
  const top = a ? Math.min(y(a.value), pad.t + ih - 4) : 0;
  const pill = a ? format(a.value) : '';
  const pw = Math.max(40, pill.length * 7 + 16);

  return (
    <div ref={ref} style={{ position: 'relative', height }} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={bars.map(b => `${b.label} ${format(b.value)}`).join(', ')}>
          <defs>
            <linearGradient id={`bi${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--bar)' }} />
              <stop offset="1" style={{ stopColor: 'var(--bar-2)' }} />
            </linearGradient>
            <linearGradient id={`ba${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: 'var(--m-brand-2)' }} />
              <stop offset="1" style={{ stopColor: 'var(--m-brand)' }} />
            </linearGradient>
          </defs>
          {ticks.map(t => (
            <text key={t} x={0} y={y(t)} dy="0.35em" fontSize="11" fill="var(--text-3)" className="tnum">{tickFormat ? tickFormat(t, step) : format(t)}</text>
          ))}
          {bars.map((b, i) => {
            const h = Math.max(4, pad.t + ih - y(b.value));
            const x = pad.l + band * i + (band - bw) / 2;
            const on = i === act;
            return (
              <path
                key={b.label + i}
                d={topRounded(x, pad.t + ih - h, bw, h, 9)}
                fill={`url(#${on ? 'ba' : 'bi'}${uid})`}
                style={{ transition: 'fill .2s', filter: on ? 'drop-shadow(0 8px 16px rgba(47,92,240,.45))' : undefined }}
              />
            );
          })}
          {a && (
            <g style={{ transition: 'transform .2s' }}>
              <rect x={ax - pw / 2} y={top - 28} width={pw} height={22} rx={11} fill="var(--surface-3)" stroke="var(--border-2)" />
              <text x={ax} y={top - 17} dy="0.35em" textAnchor="middle" fontSize="11.5" fontWeight="600" fill="var(--text)" className="tnum">{pill}</text>
            </g>
          )}
          {bars.map((b, i) => (
            <text key={`l${i}`} x={pad.l + band * i + band / 2} y={height - 6} textAnchor="middle" fontSize="11" fill={i === act ? 'var(--text)' : 'var(--text-3)'}>{b.label}</text>
          ))}
          {bars.map((b, i) => (
            <rect key={`h${i}`} x={pad.l + band * i} y={0} width={band} height={height} fill="transparent" onMouseEnter={() => setHover(i)}>
              <title>{b.detail ?? `${b.label}: ${format(b.value)}`}</title>
            </rect>
          ))}
        </svg>
      )}
    </div>
  );
}

const pt = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const t = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(t), cy - r * Math.sin(t)];
};

/** Upper half-annulus from angle a0 down to a1 (degrees, 180 = left, 0 = right). */
function annulus(cx: number, cy: number, R: number, r: number, a0: number, a1: number) {
  const [x0, y0] = pt(cx, cy, R, a0);
  const [x1, y1] = pt(cx, cy, R, a1);
  const [x2, y2] = pt(cx, cy, r, a1);
  const [x3, y3] = pt(cx, cy, r, a0);
  const large = a0 - a1 > 180 ? 1 : 0;
  return `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
}

export interface GaugeSegment { key: string; label: string; value: number; c1: string; c2: string }

/** Half-donut split into segments with small gaps; hovering a segment (or its legend) focuses it. */
export function SegmentGauge({ segments, active, onActive, total: totalLabel }: {
  segments: GaugeSegment[]; active: string | null; onActive: (k: string | null) => void; total: string;
}) {
  const uid = useId().replace(/:/g, '');
  const W = 260, cx = 130, cy = 128, R = 122, T = 32;
  const live = segments.filter(s => s.value > 0);
  const total = live.reduce((n, s) => n + s.value, 0);
  const gap = live.length > 1 ? 1.8 : 0;
  const avail = 180 - gap * (live.length - 1);
  const minSweep = 2.4;
  const raw = live.map(s => Math.max(minSweep, (s.value / (total || 1)) * avail));
  const k = avail / raw.reduce((a, b) => a + b, 0);
  let a = 180;
  const arcs = live.map((s, i) => {
    const sweep = raw[i] * k;
    const a0 = a;
    const a1 = a - sweep;
    a = a1 - gap;
    return { s, a0, a1 };
  });
  const focus = live.find(s => s.key === active);
  return (
    <div style={{ position: 'relative' }} onMouseLeave={() => onActive(null)}>
      <svg viewBox={`0 0 ${W} ${cy + 2}`} width="100%" role="img" aria-label={live.map(s => `${s.label} ${s.value}`).join(', ')}>
        <defs>
          {arcs.map(({ s, a0, a1 }) => {
            const [x0, y0] = pt(cx, cy, R, a0);
            const [x1, y1] = pt(cx, cy, R, a1);
            return (
              <linearGradient key={s.key} id={`g${uid}${s.key}`} gradientUnits="userSpaceOnUse" x1={x0} y1={y0} x2={x1} y2={y1}>
                <stop offset="0" style={{ stopColor: s.c1 }} />
                <stop offset="1" style={{ stopColor: s.c2 }} />
              </linearGradient>
            );
          })}
        </defs>
        {total === 0 && <path d={annulus(cx, cy, R, R - T, 180, 0)} fill="var(--track)" />}
        {arcs.map(({ s, a0, a1 }) => (
          <path
            key={s.key}
            d={annulus(cx, cy, R, R - T, a0, a1)}
            fill={`url(#g${uid}${s.key})`}
            opacity={active && active !== s.key ? 0.3 : 1}
            style={{ transition: 'opacity .2s', cursor: 'pointer' }}
            onMouseEnter={() => onActive(s.key)}
          />
        ))}
      </svg>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, textAlign: 'center', pointerEvents: 'none' }}>
        <div className="tnum" style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.03em', lineHeight: 1.1 }}>{focus ? num(focus.value) : num(total)}</div>
        <div className="small faint">{focus ? `${focus.label} · ${((focus.value / (total || 1)) * 100).toFixed(1)}%` : totalLabel}</div>
      </div>
    </div>
  );
}

/** A wide arc that runs off the card edges, filled from the left to `value` (0..1). */
export function ArcGauge({ value, label }: { value: number; label: string }) {
  const uid = useId().replace(/:/g, '');
  const cx = 100, cy = 122, R = 102, T = 28;
  const v = Math.max(0, Math.min(1, value));
  const a1 = 180 - v * 180;
  const [x0, y0] = pt(cx, cy, R, 180);
  const [x1, y1] = pt(cx, cy, R, Math.max(a1, 0));
  return (
    <svg viewBox="0 0 200 118" width="100%" preserveAspectRatio="xMidYMax slice" role="img" aria-label={label} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`t${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" style={{ stopColor: 'var(--track)' }} />
          <stop offset="1" style={{ stopColor: 'var(--bar-2)' }} />
        </linearGradient>
        <linearGradient id={`v${uid}`} gradientUnits="userSpaceOnUse" x1={x0} y1={y0} x2={x1} y2={y1}>
          <stop offset="0" style={{ stopColor: 'var(--m-brand)', stopOpacity: 0.25 }} />
          <stop offset="1" style={{ stopColor: 'var(--m-brand-2)' }} />
        </linearGradient>
      </defs>
      <path d={annulus(cx, cy, R, R - T, 180, 0)} fill={`url(#t${uid})`} />
      {v > 0 && <path d={annulus(cx, cy, R, R - T, 180, Math.max(a1, 0.01))} fill={`url(#v${uid})`} style={{ filter: 'drop-shadow(0 0 10px rgba(74,116,255,.45))' }} />}
    </svg>
  );
}

function smoothPath(pts: Array<[number, number]>) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0].toFixed(1)},${c1[1].toFixed(1)} ${c2[0].toFixed(1)},${c2[1].toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Full-bleed area chart with a crosshair tooltip. */
export function AreaChart({ values, labels, height = 118, color = 'var(--m-area)', format = num }: {
  values: number[]; labels: string[]; height?: number; color?: string; format?: (n: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, '');
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => [values.length > 1 ? (i / (values.length - 1)) * width : 0, 10 + (1 - v / max) * (height - 16)] as [number, number]);
  const line = smoothPath(pts);
  const area = line ? `${line} L${width},${height} L0,${height} Z` : '';
  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * (values.length - 1));
    setHover(Math.max(0, Math.min(values.length - 1, i)));
  };
  const h = hover !== null ? pts[hover] : null;
  return (
    <div ref={ref} style={{ position: 'relative', height }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true" style={{ display: 'block' }}>
          <defs>
            <linearGradient id={`a${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" style={{ stopColor: color, stopOpacity: 0.42 }} />
              <stop offset="1" style={{ stopColor: color, stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#a${uid})`} />
          <path d={line} fill="none" style={{ stroke: color }} strokeWidth="2" strokeLinejoin="round" />
          {h && (
            <>
              <line x1={h[0]} x2={h[0]} y1={0} y2={height} stroke="var(--border-2)" strokeDasharray="3 3" />
              <circle cx={h[0]} cy={h[1]} r={4.5} style={{ fill: color }} stroke="var(--surface)" strokeWidth="2" />
            </>
          )}
        </svg>
      )}
      {h && hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(Math.max(h[0], 60), width - 60), top: Math.max(h[1] - 10, 40), minWidth: 0 }}>
          <b className="tnum">{format(values[hover])}</b> <span className="faint">{labels[hover]}</span>
        </div>
      )}
    </div>
  );
}
