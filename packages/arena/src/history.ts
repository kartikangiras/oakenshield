/*
 * What the agents are allowed to know: a few days of past five minute markets, rebuilt from
 * public candles. The older part is the fact sheet both agents get. The newest part is held
 * out: no agent sees it, the referee scores the final playbooks on it before the start, and the
 * score goes into the record. The live experiment is still the only judge.
 */
import { SIGNAL_NAMES } from './playbook.ts';
import type { Asset, SignalName, Situation } from './playbook.ts';
import { LOOKBACK_MINUTES, situations } from './signals.ts';
import { history } from './spot.ts';

export interface Past {
  from: number;
  /** Markets that open before this are shown to the agents; the rest are held out. */
  cut: number;
  to: number;
  seen: Situation[];
  held: Situation[];
}

export async function loadPast(assets: Asset[], hours: number, heldHours: number, end = Math.floor(Date.now() / 1000)): Promise<Past> {
  const to = Math.floor(end / 300) * 300;
  const from = to - hours * 3600;
  const cut = to - heldHours * 3600;
  const need = hours + Math.ceil(LOOKBACK_MINUTES / 60) + 1;
  const btc = await history('btc', need, to);
  const all: Situation[] = [];
  for (const asset of assets) {
    const own = asset === 'btc' ? btc : await history(asset, need, to);
    all.push(...situations(asset, own, btc, from, to));
  }
  all.sort((a, b) => a.start - b.start || a.asset.localeCompare(b.asset));
  return { from, cut, to, seen: all.filter(s => s.start < cut), held: all.filter(s => s.start >= cut) };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const upRate = (rows: Situation[]) => (rows.length ? rows.filter(s => s.up).length / rows.length : 0);
const cell = (label: string, rows: Situation[]) => `${label}: ${rows.length ? `${pct(upRate(rows))} of ${rows.length}` : 'none'}`;
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const date = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

/** Four cut points that split the values into five groups of about the same size. */
function quintiles(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const cuts = [0.2, 0.4, 0.6, 0.8].map(q => Math.round(sorted[Math.floor(q * (sorted.length - 1))]! * 100) / 100);
  return [...new Set(cuts)];
}

function bySignal(rows: Situation[], signal: SignalName): string {
  if (signal === 'streak') {
    const groups: [string, (x: number) => boolean][] = [['-3 or lower', x => x <= -3], ['-2', x => x === -2], ['-1', x => x === -1], ['0', x => x === 0], ['1', x => x === 1], ['2', x => x === 2], ['3 or higher', x => x >= 3]];
    return groups.map(([label, f]) => cell(label, rows.filter(s => f(s.signals.streak)))).join(' | ');
  }
  if (signal === 'hour_utc') {
    return [0, 6, 12, 18].map(h => cell(`${h} to ${h + 5}`, rows.filter(s => s.signals.hour_utc >= h && s.signals.hour_utc < h + 6))).join(' | ');
  }
  const cuts = quintiles(rows.map(s => s.signals[signal]));
  const groups = [-Infinity, ...cuts, Infinity];
  return groups.slice(0, -1).map((lo, i) => {
    const hi = groups[i + 1]!;
    const label = lo === -Infinity ? `below ${hi}` : hi === Infinity ? `${lo} or more` : `${lo} to ${hi}`;
    return cell(label, rows.filter(s => s.signals[signal] >= lo && s.signals[signal] < hi));
  }).join(' | ');
}

/** The fact sheet: how often "up" won in the seen markets, overall and split by each signal. */
export function factSheet(rows: Situation[], from: number, to: number): string {
  if (!rows.length) return 'No past markets were available.';
  const assets = [...new Set(rows.map(s => s.asset))];
  const sign = (a: SignalName, b: SignalName, sa: number, sb: number) => rows.filter(s => Math.sign(s.signals[a]) === sa && Math.sign(s.signals[b]) === sb);
  const move = rows.map(s => Math.abs(s.signals.ret_5m)).sort((a, b) => a - b);
  const big = Math.round(move[Math.floor(0.9 * (move.length - 1))]! * 100) / 100;
  const stretched = (dir: number, burst: boolean) => rows.filter(s => s.signals.ret_5m * dir >= big && (s.signals.volume_ratio >= 1.5) === burst);
  return [
    `${rows.length} five minute markets on ${assets.length} assets, ${day(from)} to ${day(to)} UTC, rebuilt from one minute prices.`,
    `Up won ${pct(upRate(rows))} of them (a tie counts as up).`,
    `By day: ${[...new Set(rows.map(s => date(s.start)))].map(d => cell(d, rows.filter(s => date(s.start) === d))).join(' | ')}. The overall share drifts from day to day, so leaning on it is not an edge.`,
    'A share measured on 1,000 markets is uncertain by about 3 points either way, on 300 markets by about 6. Most differences below are inside that noise.',
    '',
    'How often up won, split by each signal (share, then number of markets):',
    ...SIGNAL_NAMES.map(n => `${n}  ${bySignal(rows, n)}`),
    `asset  ${assets.map(a => cell(a, rows.filter(s => s.asset === a))).join(' | ')}`,
    '',
    'Two signals at once:',
    `ret_5m up, ret_60m up  ${cell('', sign('ret_5m', 'ret_60m', 1, 1)).slice(2)} | ret_5m up, ret_60m down  ${cell('', sign('ret_5m', 'ret_60m', 1, -1)).slice(2)} | ret_5m down, ret_60m up  ${cell('', sign('ret_5m', 'ret_60m', -1, 1)).slice(2)} | ret_5m down, ret_60m down  ${cell('', sign('ret_5m', 'ret_60m', -1, -1)).slice(2)}`,
    `ret_5m at least ${big}: with volume_ratio 1.5 or more  ${cell('', stretched(1, true)).slice(2)} | with less  ${cell('', stretched(1, false)).slice(2)}`,
    `ret_5m at most -${big}: with volume_ratio 1.5 or more  ${cell('', stretched(-1, true)).slice(2)} | with less  ${cell('', stretched(-1, false)).slice(2)}`,
  ].join('\n');
}
