/*
 * Polymarket, read only: the five minute "Up or Down" markets, their order books and how they
 * resolved. No account, no key, no order is ever sent. The arena only needs what anyone can see:
 * what a trade would have cost at that moment, and which side won.
 */
import { getJson, NotFound } from './net.ts';
import type { Asset, Side } from './playbook.ts';
import { WINDOW } from './signals.ts';

const GAMMA = process.env.ARENA_GAMMA_URL ?? 'https://gamma-api.polymarket.com';
const CLOB = process.env.ARENA_CLOB_URL ?? 'https://clob.polymarket.com';

export interface Fee { rate: number; exponent: number }
export interface Market {
  /** Polymarket's own name for the market, and the identity the experiment buckets. */
  slug: string;
  asset: Asset;
  start: number;
  end: number;
  question: string;
  condition: string;
  tokens: Record<Side, string>;
  fee: Fee;
  minShares: number;
}
export interface Level { price: number; size: number }

export const slugOf = (asset: Asset, start: number) => `${asset}-updown-5m-${start}`;
export const urlOf = (slug: string) => `https://polymarket.com/event/${slug}`;

interface GammaMarket {
  question?: string; conditionId?: string; outcomes?: string; clobTokenIds?: string; eventStartTime?: string; endDate?: string;
  feesEnabled?: boolean; feeSchedule?: { rate?: number; exponent?: number } | null; orderMinSize?: number;
}

/** The market on `asset` for the five minutes from `start`. Null when Polymarket lists none. */
export async function findMarket(asset: Asset, start: number): Promise<Market | null> {
  const slug = slugOf(asset, start);
  let events: { markets?: GammaMarket[] }[];
  try { events = await getJson(`${GAMMA}/events?slug=${slug}`, { tries: 6, timeout: 6000 }); } catch (e) { if (e instanceof NotFound) return null; throw e; }
  const m = events[0]?.markets?.[0];
  if (!m?.conditionId || !m.clobTokenIds || !m.outcomes) return null;
  const outcomes = JSON.parse(m.outcomes) as string[];
  const ids = JSON.parse(m.clobTokenIds) as string[];
  const up = ids[outcomes.indexOf('Up')], down = ids[outcomes.indexOf('Down')];
  const opens = m.eventStartTime ? Date.parse(m.eventStartTime) / 1000 : start;
  if (!up || !down || opens !== start) return null;
  return {
    slug, asset, start, end: m.endDate ? Date.parse(m.endDate) / 1000 : start + WINDOW,
    question: m.question ?? slug, condition: m.conditionId, tokens: { up, down },
    fee: m.feesEnabled === false ? { rate: 0, exponent: 1 } : { rate: m.feeSchedule?.rate ?? 0, exponent: m.feeSchedule?.exponent ?? 1 },
    minShares: m.orderMinSize ?? 5,
  };
}

/** What is for sale on one side right now, cheapest first. */
export async function asks(token: string): Promise<Level[]> {
  const book = await getJson<{ asks?: { price: string; size: string }[] }>(`${CLOB}/book?token_id=${token}`, { tries: 3, timeout: 5000 });
  return (book.asks ?? []).map(l => ({ price: +l.price, size: +l.size })).filter(l => l.price > 0 && l.size > 0).sort((a, b) => a.price - b.price);
}

/** The side that won, once Polymarket has resolved the market. Null until then. */
export async function resolution(condition: string): Promise<Side | null> {
  const m = await getJson<{ closed?: boolean; tokens?: { outcome: string; winner: boolean }[] }>(`${CLOB}/markets/${condition}`, { tries: 3, timeout: 5000 });
  const won = m.closed ? m.tokens?.filter(t => t.winner) : undefined;
  if (won?.length !== 1) return null;
  return won[0]!.outcome === 'Up' ? 'up' : won[0]!.outcome === 'Down' ? 'down' : null;
}
