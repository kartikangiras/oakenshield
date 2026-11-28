/*
 * The playbook: the small language a trader is written in. An agent cannot ship code, only one
 * of these: an ordered list of rules over a fixed set of price signals, and a side to take when
 * no rule fires. The whole trader is the value of one Flagsmith flag, so what trades is whatever
 * the flag serves, and every call can be recomputed from the logged signals and the sealed value.
 */
import { createHash } from 'node:crypto';

export type Side = 'up' | 'down';
export const ASSETS = ['btc', 'eth', 'sol', 'xrp', 'doge', 'bnb', 'hype', 'zec'] as const;
export type Asset = (typeof ASSETS)[number];

/** Every number a rule may look at. All of them are known one minute before the market opens. */
export const SIGNALS = {
  ret_1m: { min: -5, max: 5, about: 'the asset\'s price change over the last 1 minute, in percent' },
  ret_5m: { min: -10, max: 10, about: 'the asset\'s price change over the last 5 minutes, in percent' },
  ret_15m: { min: -15, max: 15, about: 'the asset\'s price change over the last 15 minutes, in percent' },
  ret_60m: { min: -25, max: 25, about: 'the asset\'s price change over the last 60 minutes, in percent' },
  btc_ret_5m: { min: -10, max: 10, about: 'Bitcoin\'s price change over the last 5 minutes, in percent (equal to ret_5m when the asset is btc)' },
  btc_ret_15m: { min: -15, max: 15, about: 'Bitcoin\'s price change over the last 15 minutes, in percent' },
  streak: { min: -12, max: 12, about: 'how many five minute steps in a row the price moved the same way: 3 is three rises in a row, -2 is two falls in a row, 0 is an unchanged last step' },
  range_15m: { min: 0, max: 20, about: 'the highest price minus the lowest over the last 15 minutes, in percent of the price: how wild the market is' },
  volume_ratio: { min: 0, max: 50, about: 'the last 5 minutes of traded volume divided by the average 5 minutes of the last hour: 1 is normal, 3 is a burst' },
  hour_utc: { min: 0, max: 23, about: 'the hour of the day the market opens in, UTC' },
} as const;
export type SignalName = keyof typeof SIGNALS;
export type Signals = Record<SignalName, number>;
export const SIGNAL_NAMES = Object.keys(SIGNALS) as SignalName[];

export const OPS = ['>', '>=', '<', '<='] as const;
export type Op = (typeof OPS)[number];

export interface Condition { signal: SignalName; op: Op; value: number }
export interface Rule {
  /** Every condition has to hold. */
  when: Condition[];
  side: Side;
  /** Only for these assets. Left out: every asset. */
  assets?: Asset[];
  why?: string;
}
export interface Playbook { version: 1; kind: 'playbook'; name: string; rules: Rule[]; otherwise: Side }
/** The control version: no opinion at all. The seed is published before the start, so every flip can be checked. */
export interface Coin { version: 1; kind: 'coin'; seed: string }
export type Trader = Playbook | Coin;

export const LIMITS = { rules: 8, conditions: 4, name: 48, why: 160, minSideShare: 0.3, minRuleFires: 5 };

export interface Problem { code: string; message: string }
/** One market the way a playbook sees it, with how it resolved. The referee and the backtest run on these. */
export interface Situation { asset: Asset; start: number; signals: Signals; up: boolean }

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isSide = (x: unknown): x is Side => x === 'up' || x === 'down';

/**
 * Reads a playbook an agent wrote. Returns the playbook with only the fields the language has,
 * or the reasons it is not one. Bounds are checked here; what it does on real data is `review`.
 */
export function parsePlaybook(value: unknown): { playbook: Playbook | null; problems: Problem[] } {
  const problems: Problem[] = [];
  const bad = (code: string, message: string) => { problems.push({ code, message }); };
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  if (!isObject(value)) return { playbook: null, problems: [{ code: 'shape', message: 'A playbook is one JSON object.' }] };
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > LIMITS.name) bad('name', `"name" is 1 to ${LIMITS.name} characters.`);
  if (!isSide(value.otherwise)) bad('otherwise', '"otherwise" is "up" or "down": a trader takes a side in every market.');
  const raw = Array.isArray(value.rules) ? value.rules : [];
  if (raw.length < 1 || raw.length > LIMITS.rules) bad('rules', `"rules" holds 1 to ${LIMITS.rules} rules.`);
  const rules: Rule[] = [];
  raw.slice(0, LIMITS.rules).forEach((r, i) => {
    const at = `Rule ${i + 1}`;
    if (!isObject(r)) { bad('rule', `${at} is not an object.`); return; }
    if (!isSide(r.side)) bad('side', `${at}: "side" is "up" or "down".`);
    const whenRaw = Array.isArray(r.when) ? r.when : [];
    if (whenRaw.length < 1 || whenRaw.length > LIMITS.conditions) bad('when', `${at}: "when" holds 1 to ${LIMITS.conditions} conditions.`);
    const when: Condition[] = [];
    for (const c of whenRaw.slice(0, LIMITS.conditions)) {
      if (!isObject(c) || typeof c.signal !== 'string' || !(c.signal in SIGNALS)) { bad('signal', `${at}: unknown signal ${JSON.stringify(isObject(c) ? c.signal : c)}. The signals are ${SIGNAL_NAMES.join(', ')}.`); continue; }
      const signal = c.signal as SignalName;
      if (!OPS.includes(c.op as Op)) { bad('op', `${at}: "op" is one of ${OPS.join(' ')}.`); continue; }
      const { min, max } = SIGNALS[signal];
      if (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < min || c.value > max) { bad('value', `${at}: ${signal} is compared with a number from ${min} to ${max}.`); continue; }
      when.push({ signal, op: c.op as Op, value: c.value });
    }
    let assets: Asset[] | undefined;
    if (r.assets !== undefined) {
      const list = Array.isArray(r.assets) ? r.assets : [];
      if (!list.length || list.some(a => !ASSETS.includes(a as Asset))) bad('assets', `${at}: "assets" is a list from ${ASSETS.join(', ')}, or is left out.`);
      else assets = [...new Set(list as Asset[])];
    }
    const why = typeof r.why === 'string' ? r.why.trim().slice(0, LIMITS.why) : undefined;
    if (isSide(r.side) && when.length) rules.push({ when, side: r.side, ...(assets ? { assets } : {}), ...(why ? { why } : {}) });
  });
  if (problems.length) return { playbook: null, problems };
  return { playbook: { version: 1, kind: 'playbook', name, rules, otherwise: value.otherwise as Side }, problems };
}

/** Whatever the flag serves, as a trader. Null when the value is not one, and then nothing trades. */
export function parseTrader(value: unknown): Trader | null {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!isObject(value)) return null;
  if (value.kind === 'coin') return typeof value.seed === 'string' && value.seed ? { version: 1, kind: 'coin', seed: value.seed } : null;
  return parsePlaybook(value).playbook;
}

const holds = (c: Condition, s: Signals): boolean => {
  const x = s[c.signal];
  return c.op === '>' ? x > c.value : c.op === '>=' ? x >= c.value : c.op === '<' ? x < c.value : x <= c.value;
};

/** The coin's call for one market: the first bit of sha256(seed, market). */
export const flip = (seed: string, market: string): Side =>
  (createHash('sha256').update(`${seed}:${market}`).digest()[0]! & 1) === 1 ? 'up' : 'down';

export interface Call {
  side: Side;
  /** Which rule made the call, counted from 1. 0 when none fired (or for the coin). */
  rule: number;
}

/** A trader's call for one market. The same inputs always give the same call. */
export function decide(trader: Trader, signals: Signals, asset: Asset, market: string): Call {
  if (trader.kind === 'coin') return { side: flip(trader.seed, market), rule: 0 };
  const i = trader.rules.findIndex(r => (!r.assets || r.assets.includes(asset)) && r.when.every(c => holds(c, signals)));
  return i < 0 ? { side: trader.otherwise, rule: 0 } : { side: trader.rules[i]!.side, rule: i + 1 };
}

export interface Tape {
  markets: number;
  right: number;
  rate: number;
  /** Share of calls that said up. */
  up: number;
  /** Per rule, in order; the last entry is "otherwise". */
  rules: { rule: number; fired: number; right: number }[];
}

/** How a trader would have called a set of past markets. A backtest, with everything that implies. */
export function tape(trader: Trader, situations: Situation[]): Tape {
  const n = trader.kind === 'playbook' ? trader.rules.length : 0;
  const rules = Array.from({ length: n + 1 }, (_, i) => ({ rule: i === n ? 0 : i + 1, fired: 0, right: 0 }));
  let right = 0, up = 0;
  for (const s of situations) {
    const call = decide(trader, s.signals, s.asset, `${s.asset}-updown-5m-${s.start}`);
    const ok = (call.side === 'up') === s.up;
    const row = rules[call.rule === 0 ? n : call.rule - 1]!;
    row.fired++;
    if (ok) { row.right++; right++; }
    if (call.side === 'up') up++;
  }
  const m = situations.length;
  return { markets: m, right, rate: m ? right / m : 0, up: m ? up / m : 0, rules };
}

/**
 * The referee's second look: what the playbook does on real past markets. It refuses a trader
 * that always says the same thing (that is a bet on the tie rule, not a strategy) and rules that
 * never fire (dead weight nobody can evaluate).
 */
export function review(playbook: Playbook, situations: Situation[]): Problem[] {
  if (!situations.length) return [];
  const t = tape(playbook, situations);
  const problems: Problem[] = [];
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  if (t.up < LIMITS.minSideShare || t.up > 1 - LIMITS.minSideShare) {
    problems.push({ code: 'one_sided', message: `On ${t.markets} past markets it said ${t.up > 0.5 ? 'up' : 'down'} ${pct(Math.max(t.up, 1 - t.up))} of the time. Each side needs at least ${pct(LIMITS.minSideShare)} of the calls.` });
  }
  for (const r of t.rules) {
    if (r.rule && r.fired < LIMITS.minRuleFires) problems.push({ code: 'dead_rule', message: `Rule ${r.rule} fired ${r.fired} time${r.fired === 1 ? '' : 's'} in ${t.markets} past markets. Loosen it or remove it.` });
  }
  return problems;
}

/** Share of past markets on which two traders make the same call. */
export function agreement(a: Trader, b: Trader, situations: Situation[]): number {
  if (!situations.length) return 0;
  const same = situations.filter(s => {
    const m = `${s.asset}-updown-5m-${s.start}`;
    return decide(a, s.signals, s.asset, m).side === decide(b, s.signals, s.asset, m).side;
  }).length;
  return same / situations.length;
}

/** One line per rule, for a person. */
export function describe(trader: Trader): string[] {
  if (trader.kind === 'coin') return [`A coin flip per market (seed "${trader.seed}").`];
  const lines = trader.rules.map((r, i) =>
    `${i + 1}. ${r.assets ? `[${r.assets.join(', ')}] ` : ''}${r.when.map(c => `${c.signal} ${c.op} ${c.value}`).join(' and ')} -> ${r.side}${r.why ? `  (${r.why})` : ''}`);
  return [...lines, `otherwise -> ${trader.otherwise}`];
}
