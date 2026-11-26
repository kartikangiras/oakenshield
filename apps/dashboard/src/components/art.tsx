import { useId, useMemo } from 'react';
import { Icon } from './Icons.tsx';

/* Decorative, generated art: a flowing ribbon of fine lines behind the hero. Drawn in code. */

export function HeroArt() {
  const uid = useId().replace(/:/g, '');
  const ribbons = useMemo(() => {
    const out: Array<{ d: string; o: number }> = [];
    const N = 64;
    for (let i = 0; i < N; i++) {
      const s = i / (N - 1);
      const tw = Math.sin(s * Math.PI);
      const x0 = 470 + 90 * s;
      const y0 = 380;
      const c1x = 690 + 300 * s;
      const c1y = 0 + 70 * tw - 40 * s;
      const c2x = 1060 - 220 * s;
      const c2y = 340 - 220 * tw;
      const x1 = 1460;
      const y1 = 40 + 150 * s;
      out.push({ d: `M${x0.toFixed(1)},${y0} C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${x1},${y1.toFixed(1)}`, o: 0.06 + 0.62 * Math.pow(tw, 2) });
    }
    return out;
  }, []);
  const mid = ribbons[Math.floor(ribbons.length / 2)].d;
  return (
    <svg className="hero-art" viewBox="0 0 1400 320" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <defs>
        <linearGradient id={`hs${uid}`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset="0.35" stopColor="#fff" stopOpacity="0.9" />
          <stop offset="0.7" stopColor="#e6eeff" stopOpacity="1" />
          <stop offset="1" stopColor="#fff" stopOpacity="0.15" />
        </linearGradient>
        <filter id={`hb${uid}`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="22" /></filter>
        <filter id={`hg${uid}`} x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="7" /></filter>
      </defs>
      <ellipse cx="960" cy="150" rx="260" ry="80" fill="#c9d9ff" opacity="0.32" filter={`url(#hb${uid})`} transform="rotate(-16 960 150)" />
      <path d={mid} fill="none" stroke="#fff" strokeOpacity="0.34" strokeWidth="54" filter={`url(#hg${uid})`} />
      <path d={mid} fill="none" stroke="#fff" strokeOpacity="0.5" strokeWidth="6" filter={`url(#hg${uid})`} />
      <g fill="none" stroke={`url(#hs${uid})`}>
        {ribbons.map((r, i) => <path key={i} d={r.d} strokeOpacity={r.o} strokeWidth={i % 4 === 0 ? 1.3 : 0.8} />)}
      </g>
    </svg>
  );
}

function hash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function Avatar({ name, size = 34 }: { name: string; size?: number }) {
  const h = hash(name) % 360;
  const bot = /agent|bot|renovate/.test(name);
  const initials = name.replace(/[^a-z0-9 -]/gi, '').split(/[-\s]/).filter(Boolean).map(w => w[0]).join('').slice(0, 2) || '?';
  return (
    <span
      className="av"
      title={`@${name}`}
      style={{ width: size, height: size, background: bot ? 'linear-gradient(135deg, #3a3f52, #1e2130)' : `linear-gradient(135deg, hsl(${h} 80% 66%), hsl(${(h + 40) % 360} 70% 48%))` }}
    >
      {bot ? <Icon name="bot" size={size * 0.48} /> : initials}
    </span>
  );
}
