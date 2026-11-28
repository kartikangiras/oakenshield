/*
 * Paper trades. A fill is what the stake would have bought from the real order book at that
 * moment, taking the cheapest offers first, plus Polymarket's taker fee. Nothing is sent
 * anywhere. A share pays 1 dollar if its side wins and nothing if it loses.
 */
import type { Fee, Level } from './market.ts';

export interface Fill {
  shares: number;
  /** Dollars paid for the shares, before the fee. */
  cost: number;
  fee: number;
  /** Average price per share. */
  price: number;
  /** The best offer at that moment. */
  top: number;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Polymarket's taker fee for `shares` bought at `price`: shares x rate x (price x (1 - price)) ^ exponent. */
export const feeFor = (shares: number, price: number, fee: Fee) => shares * fee.rate * (price * (1 - price)) ** fee.exponent;

/** Spends `stake` dollars on the offers, cheapest first. Null when the book cannot fill it. */
export function fill(offers: Level[], stake: number, fee: Fee, minShares = 0): Fill | null {
  let left = stake, shares = 0, cost = 0, fees = 0;
  for (const l of offers) {
    if (left <= 1e-9) break;
    const take = Math.min(l.size, left / l.price);
    shares += take; cost += take * l.price; fees += feeFor(take, l.price, fee); left -= take * l.price;
  }
  if (left > 1e-6 || shares < minShares || !offers.length) return null;
  return { shares: round(shares), cost: round(cost), fee: round(fees, 5), price: round(cost / shares), top: offers[0]!.price };
}

/** What a filled trade is worth once the market has resolved. */
export function settle(f: Pick<Fill, 'shares' | 'cost' | 'fee'>, won: boolean): { payout: number; profit: number } {
  const payout = won ? f.shares : 0;
  return { payout: round(payout), profit: round(payout - f.cost - f.fee) };
}
