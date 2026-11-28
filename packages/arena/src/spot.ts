/*
 * Spot prices: one minute candles from Binance's public market data host. No key, no account.
 * These feed the signals. They never decide who won a market; Polymarket's resolution does.
 */
import { getJson } from './net.ts';
import type { Asset } from './playbook.ts';
import type { Candle } from './signals.ts';

const HOSTS = (process.env.ARENA_SPOT_URLS ?? 'https://data-api.binance.vision,https://api.binance.com').split(',');
const symbol = (asset: Asset) => `${asset.toUpperCase()}USDT`;

type Row = [number, string, string, string, string, string, ...unknown[]];

/** Up to 1,000 one minute candles, oldest first, ending at `end` (seconds) or now. */
export async function candles(asset: Asset, limit: number, end?: number): Promise<Candle[]> {
  let last: unknown;
  for (const host of HOSTS) {
    try {
      const rows = await getJson<Row[]>(`${host}/api/v3/klines?symbol=${symbol(asset)}&interval=1m&limit=${limit}${end ? `&endTime=${end * 1000 - 1}` : ''}`, { tries: 2 });
      return rows.map(r => ({ t: r[0] / 1000, o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] }));
    } catch (e) { last = e; }
  }
  throw last;
}

/** The last `hours` of one minute candles, oldest first. */
export async function history(asset: Asset, hours: number, end = Math.floor(Date.now() / 1000)): Promise<Candle[]> {
  const out: Candle[] = [];
  let until = Math.floor(end / 60) * 60;
  const from = until - hours * 3600;
  while (until > from) {
    const page = await candles(asset, Math.min(1000, Math.ceil((until - from) / 60)), until);
    if (!page.length) break;
    out.unshift(...page);
    until = page[0]!.t;
  }
  return out;
}
