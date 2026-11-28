import './duel-viz.css';

/*
 * The duel, replayed: one lane per version, one dot per visitor. A dot comes in from the left and
 * settles at the front of its lane if that visitor converted, at the far end if not, so a full
 * lane reads as a bar: the solid part is the share that converted.
 *
 * Plain DOM and canvas, no framework, because two pages use it: the landing page (landing.ts) and
 * the dashboard (pages/Duel.tsx). Colours come from the page: --dv-1, --dv-2, … for the lanes and
 * --dv-track for what they sit on.
 *
 * The page's words do not change while the dots move. The final numbers are in the text from the
 * start, for a screen reader and for anything that waits for a page to settle (the persona
 * visitors do, scripts/traffic/personas.mjs); the counting is drawn by the stylesheet from
 * attributes.
 */

export interface VizLane {
  key: string;
  label: string;
  /** A few words under the name. */
  note?: string;
  visitors: number;
  converted: number;
}

export interface VizOptions {
  /** In the order the codes in `visits` count them. */
  lanes: VizLane[];
  /** The lane the others are measured against. It is drawn last, under the contenders. */
  baseline?: string;
  /** One character per visitor in the order they finished, as scripts/traffic/replay.mjs writes it. */
  visits?: string;
  /** What a converted visitor did: "ran a check". */
  did: string;
  /** What one dot is, in the plural. "visitors" unless the page says otherwise (the arena: "markets"). */
  unit?: string;
  /** The key under the lanes for a dim dot. "Did not" unless the page says otherwise. */
  missed?: string;
  winner?: string | null;
  /** What `status` says once every visitor is in: "Agent B wins". */
  result: string;
  /** An element outside the lanes that shows the visitors counted so far, then the result. */
  status?: HTMLElement | null;
  caption?: string;
  /** Play when it first comes into view. Without it, it opens on the end state. */
  autoplay?: boolean;
  /** How long to hold the first play back, in milliseconds, while the page settles. */
  delay?: number;
  /** Called each time a replay starts. */
  onPlay?: () => void;
}

const SECONDS = 7;
const FLIGHT = 620;
const PAD = 8;
const DIM = 0.24;
const MIN_PITCH = 7;
const MAX_PITCH = 10;

/** cubic-bezier(x1, y1, x2, y2) as a function of time, found by bisection. */
function bezier(x1: number, y1: number, x2: number, y2: number) {
  const at = (a: number, b: number, s: number) => 3 * a * s * (1 - s) ** 2 + 3 * b * s * s * (1 - s) + s ** 3;
  return (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (at(x1, x2, mid) < x) lo = mid; else hi = mid;
    }
    return at(y1, y2, (lo + hi) / 2);
  };
}
const ease = bezier(0.32, 0.72, 0, 1);

/**
 * The visitors as codes: the lane's index times two, plus one if they converted. Without a log,
 * or with one that disagrees with the counts, the same dots are dealt in a fixed, made-up order.
 */
function codes(lanes: VizLane[], visits = ''): number[] {
  const want = lanes.flatMap(l => [l.visitors - l.converted, l.converted]);
  const logged = [...visits].map(c => parseInt(c, 36));
  const have = want.map(() => 0);
  for (const c of logged) have[c]++;
  if (logged.length && want.every((n, i) => n === have[i])) return logged;
  const dealt = want.flatMap((n, code) => Array<number>(Math.max(0, n)).fill(code));
  let seed = 1497;
  for (let i = dealt.length - 1; i > 0; i--) {
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    const j = ((r ^ (r >>> 14)) >>> 0) % (i + 1);
    [dealt[i], dealt[j]] = [dealt[j]!, dealt[i]!];
  }
  return dealt;
}

const count = (n: number) => n.toLocaleString('en-US');
const share = (n: number, of: number) => `${(of ? (n / of) * 100 : 0).toFixed(1)}%`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const REPLAY_ICON = '<svg viewBox="0 0 256 256" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M224,128a96,96,0,0,1-94.71,96H128A95.38,95.38,0,0,1,62.1,197.8a8,8,0,0,1,11-11.63A80,80,0,1,0,71.43,71.39a3.07,3.07,0,0,1-.26.25L44.59,96H72a8,8,0,0,1,0,16H24a8,8,0,0,1-8-8V56a8,8,0,0,1,16,0V85.8L60.25,60A96,96,0,0,1,224,128Z"/></svg>';

export function mountDuelViz(root: HTMLElement, opt: VizOptions): { destroy(): void } {
  const { lanes } = opt;
  const unit = opt.unit ?? 'visitors';
  const order = codes(lanes, opt.visits);
  const n = order.length;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Where each visitor's dot ends up: converted visitors fill their lane from the front,
  // the others from the end.
  const slot = new Int32Array(n);
  {
    const hits = lanes.map(() => 0);
    const misses = lanes.map(() => 0);
    order.forEach((code, i) => {
      const lane = code >> 1;
      slot[i] = code & 1 ? hits[lane]!++ : lanes[lane]!.visitors - 1 - misses[lane]!++;
    });
  }
  // When each dot sets off: a few at first, so one dot can be seen to be one visitor, then a
  // stream, then the last few.
  const sets = Float64Array.from({ length: n }, (_, i) => {
    const u = n > 1 ? i / (n - 1) : 1;
    return SECONDS * 1000 * (u < 0.5 ? Math.sqrt(u / 2) : 1 - Math.sqrt((1 - u) / 2));
  });
  const length = SECONDS * 1000 + FLIGHT;

  root.classList.add('dv');
  root.classList.remove('dv-done');
  const rows = lanes.map((lane, i) => {
    const row = el('div', 'dv-lane');
    row.style.setProperty('--dv-c', `var(--dv-${i + 1}, currentColor)`);
    const who = el('div', 'dv-who');
    const name = el('span', 'dv-name', lane.label);
    if (lane.key === opt.winner) {
      row.classList.add('dv-won');
      const won = el('span', 'dv-win', 'Winner');
      won.setAttribute('aria-hidden', 'true');
      name.append(won);
    }
    who.append(name);
    if (lane.note) who.append(el('span', 'dv-note', lane.note));
    const field = el('div', 'dv-field');
    const canvas = el('canvas', 'dv-dots');
    canvas.setAttribute('aria-hidden', 'true');
    field.append(canvas);
    const score = el('div', 'dv-score');
    score.setAttribute('aria-hidden', 'true');
    const rate = el('span', 'dv-rate');
    const tally = el('span', 'dv-count');
    score.append(rate, tally);
    const spoken = el('span', 'dv-sr', `${lane.label}: ${count(lane.converted)} of ${count(lane.visitors)} ${unit} ${opt.did}, ${share(lane.converted, lane.visitors)}.${lane.key === opt.winner ? ' Winner.' : ''}`);
    row.append(who, field, score, spoken);
    return { row, field, canvas, rate, tally, ctx: canvas.getContext('2d'), colour: '', hits: 0, misses: 0 };
  });
  const list = el('div', 'dv-lanes');
  list.append(...rows.filter((_, i) => lanes[i]!.key !== opt.baseline).map(r => r.row), ...rows.filter((_, i) => lanes[i]!.key === opt.baseline).map(r => r.row));

  const foot = el('div', 'dv-foot');
  const did = opt.did.charAt(0).toUpperCase() + opt.did.slice(1);
  for (const [cls, text] of [['dv-hit', did], ['dv-miss', opt.missed ?? 'Did not']] as const) {
    const key = el('span', 'dv-key');
    key.append(el('i', cls), text);
    foot.append(key);
  }
  if (opt.caption) foot.append(el('span', 'dv-caption', opt.caption));
  const again = el('button', 'dv-replay');
  again.type = 'button';
  again.innerHTML = `${REPLAY_ICON}Replay`;
  if (!still) foot.append(again);
  root.replaceChildren(list, foot);
  opt.status?.replaceChildren(el('span', 'dv-said', opt.result));

  // The grid: as few rows as keep a dot big enough to see, so a lane stays a bar.
  let pitch = 0;
  let depth = 0;
  let dpr = 1;
  function layout() {
    const width = Math.max(0, ...rows.map(r => r.field.clientWidth)) - PAD * 2;
    if (width <= 0) return;
    const most = Math.max(1, ...lanes.map(l => l.visitors));
    depth = 4;
    while (depth < 16 && width / Math.ceil(most / depth) < MIN_PITCH) depth++;
    pitch = Math.min(MAX_PITCH, width / Math.ceil(most / depth));
    dpr = Math.min(3, window.devicePixelRatio || 1);
    rows.forEach((r, i) => {
      const w = Math.max(1, Math.ceil(lanes[i]!.visitors / depth)) * pitch + PAD * 2;
      const h = depth * pitch + PAD * 2;
      r.canvas.style.width = `${w}px`;
      r.canvas.style.height = `${h}px`;
      r.canvas.width = Math.round(w * dpr);
      r.canvas.height = Math.round(h * dpr);
    });
  }
  const x = (s: number) => PAD + (Math.floor(s / depth) + 0.5) * pitch;
  const y = (s: number) => PAD + ((s % depth) + 0.5) * pitch;

  let at = -1; // milliseconds into the replay; Infinity once it is over
  let set = 0; // how many dots have set off
  let landed = 0; // and how many have arrived
  function draw() {
    while (set < n && sets[set]! <= at) set++;
    while (landed < n && sets[landed]! + FLIGHT <= at) {
      const code = order[landed++]!;
      if (code & 1) rows[code >> 1]!.hits++; else rows[code >> 1]!.misses++;
    }
    if (!pitch) return;
    const radius = pitch * 0.34;
    rows.forEach((r, i) => {
      const { ctx } = r;
      if (!ctx) return;
      r.colour = getComputedStyle(r.canvas).color;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, r.canvas.width, r.canvas.height);
      ctx.fillStyle = r.colour;
      const dots = (from: number, to: number, alpha: number) => {
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        for (let s = from; s < to; s++) {
          ctx.moveTo(x(s) + radius, y(s));
          ctx.arc(x(s), y(s), radius, 0, Math.PI * 2);
        }
        ctx.fill();
      };
      dots(0, r.hits, 1);
      dots(lanes[i]!.visitors - r.misses, lanes[i]!.visitors, DIM);
      const seen = r.hits + r.misses;
      const rate = share(r.hits, seen);
      const tally = `${count(r.hits)} of ${count(seen)}`;
      if (r.rate.dataset.v !== rate) r.rate.dataset.v = rate;
      if (r.tally.dataset.v !== tally) r.tally.dataset.v = tally;
    });
    // The dots on their way: in from the left edge, halfway up the lane.
    for (let i = landed; i < set; i++) {
      const r = rows[order[i]! >> 1]!;
      if (!r.ctx) continue;
      const q = (at - sets[i]!) / FLIGHT;
      const e = ease(q);
      const hit = order[i]! & 1;
      const x0 = PAD;
      const y0 = PAD + (depth * pitch) / 2;
      r.ctx.globalAlpha = Math.min(1, q * 6) * (hit ? 1 : 1 - (1 - DIM) * e);
      r.ctx.beginPath();
      r.ctx.arc(x0 + (x(slot[i]!) - x0) * e, y0 + (y(slot[i]!) - y0) * e, radius * (0.6 + 0.4 * e), 0, Math.PI * 2);
      r.ctx.fill();
    }
    if (opt.status) {
      const counting = at === Infinity ? undefined : `${count(landed)} of ${count(n)} ${unit}`;
      if (counting === undefined) delete opt.status.dataset.dvCount;
      else if (opt.status.dataset.dvCount !== counting) opt.status.dataset.dvCount = counting;
    }
  }

  let frame = 0;
  let timer = 0;
  let began = 0;
  function finish() {
    cancelAnimationFrame(frame);
    at = Infinity;
    draw();
    root.classList.add('dv-done');
  }
  function tick(now: number) {
    began ||= now;
    at = now - began;
    if (at >= length) return finish();
    draw();
    frame = requestAnimationFrame(tick);
  }
  function play() {
    cancelAnimationFrame(frame);
    root.classList.remove('dv-done');
    for (const r of rows) r.hits = r.misses = 0;
    at = -1;
    set = landed = began = 0;
    draw();
    frame = requestAnimationFrame(tick);
    opt.onPlay?.();
  }
  again.addEventListener('click', play);

  const resized = new ResizeObserver(() => {
    layout();
    draw();
  });
  resized.observe(list);
  // The dashboard's theme is an attribute on <html>; a finished replay has to be repainted in the new colours.
  const themed = new MutationObserver(draw);
  themed.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  layout();
  let seen: IntersectionObserver | undefined;
  if (opt.autoplay && !still && 'IntersectionObserver' in window) {
    draw();
    seen = new IntersectionObserver(entries => {
      if (!entries.some(e => e.isIntersecting)) return;
      seen?.disconnect();
      timer = window.setTimeout(play, opt.delay ?? 0);
    }, { threshold: 0.4 });
    seen.observe(root);
  } else {
    finish();
  }

  return {
    destroy() {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      seen?.disconnect();
      resized.disconnect();
      themed.disconnect();
      again.removeEventListener('click', play);
      if (opt.status) delete opt.status.dataset.dvCount;
    },
  };
}
