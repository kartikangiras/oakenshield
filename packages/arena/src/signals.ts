/*
 * The signals a playbook reads, computed from one minute candles. Only closed candles are used:
 * for a market that opens at `start`, the newest candle is the one that closed a minute earlier.
 * So a signal is the same number whether it is computed live or from history a week later.
 */
import type { Asset, Signals, Situation } from './playbook.ts';

/** One minute of trading. `t` is the minute's start, in seconds. */
export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number }

/** Minutes of history a signal needs before the market opens. */
export const LOOKBACK_MINUTES = 62;
export const WINDOW = 300;

const round = (x: number) => Math.round(x * 1e4) / 1e4;
const byMinute = (candles: Candle[]) => new Map(candles.map(c => [c.t, c]));

/** The price at time t: the close of the minute that ends there. */
const priceAt = (m: Map<number, Candle>, t: number) => m.get(t - 60)?.c;

function returns(m: Map<number, Candle>, at: number, minutes: number): number | null {
  const now = priceAt(m, at), then = priceAt(m, at - minutes * 60);
  return now && then ? (now / then - 1) * 100 : null;
}

/** Signals for the market on `asset` that opens at `start`. Null when a needed minute is missing. */
export function signalsAt(own: Candle[] | Map<number, Candle>, btc: Candle[] | Map<number, Candle>, start: number): Signals | null {
  const m = own instanceof Map ? own : byMinute(own);
  const b = btc instanceof Map ? btc : byMinute(btc);
  const at = start - 60; // the last moment a closed candle covers
  const price = priceAt(m, at);
  const r1 = returns(m, at, 1), r5 = returns(m, at, 5), r15 = returns(m, at, 15), r60 = returns(m, at, 60);
  const b5 = returns(b, at, 5), b15 = returns(b, at, 15);
  if (!price || r1 === null || r5 === null || r15 === null || r60 === null || b5 === null || b15 === null) return null;

  // Five minute steps back from the decision: how many in a row went the same way as the last one.
  let streak = 0;
  for (let k = 1; k <= 12; k++) {
    const a = priceAt(m, at - 300 * (k - 1)), z = priceAt(m, at - 300 * k);
    if (!a || !z) return null;
    const d = Math.sign(a - z);
    if (k === 1) { if (d === 0) break; streak = d; continue; }
    if (d !== Math.sign(streak)) break;
    streak += d;
  }

  let high = -Infinity, low = Infinity, last5 = 0, hour = 0;
  for (let i = 1; i <= 60; i++) {
    const c = m.get(at - 60 * i);
    if (!c) return null;
    if (i <= 15) { high = Math.max(high, c.h); low = Math.min(low, c.l); }
    if (i <= 5) last5 += c.v;
    hour += c.v;
  }
  return {
    ret_1m: round(r1), ret_5m: round(r5), ret_15m: round(r15), ret_60m: round(r60),
    btc_ret_5m: round(b5), btc_ret_15m: round(b15),
    streak,
    range_15m: round(((high - low) / price) * 100),
    volume_ratio: hour > 0 ? round(last5 / (hour / 12)) : 1,
    hour_utc: new Date(start * 1000).getUTCHours(),
  };
}

/**
 * Past markets rebuilt from candles: the signals a trader would have seen, and whether the price
 * at the end of the five minutes was at or above the price at the start. Polymarket resolves on a
 * Chainlink price stream, so this is a close stand-in for the real resolution, not the same thing.
 */
export function situations(asset: Asset, own: Candle[], btc: Candle[], from: number, to: number): Situation[] {
  const m = byMinute(own), b = byMinute(btc);
  const out: Situation[] = [];
  for (let start = Math.ceil(from / WINDOW) * WINDOW; start + WINDOW <= to; start += WINDOW) {
    const open = priceAt(m, start), close = priceAt(m, start + WINDOW);
    if (!open || !close) continue;
    const signals = signalsAt(m, b, start);
    if (signals) out.push({ asset, start, signals, up: close >= open });
  }
  return out;
}
