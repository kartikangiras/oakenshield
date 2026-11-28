import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feeFor, fill, settle } from '../src/paper.ts';
import type { Fee, Level } from '../src/market.ts';

/** Polymarket's schedule for the bitcoin markets, and the one the other assets share. */
const btcFee: Fee = { rate: 0.05, exponent: 1 };
const altFee: Fee = { rate: 0.01, exponent: 1 };
const noFee: Fee = { rate: 0, exponent: 1 };

test('the fee is shares x rate x (price x (1 - price)) ^ exponent', () => {
  assert.equal(feeFor(100, 0.5, btcFee), 1.25); // 100 x 0.05 x 0.25
  assert.ok(Math.abs(feeFor(100, 0.3, btcFee) - 1.05) < 1e-12); // 100 x 0.05 x 0.21
  assert.ok(Math.abs(feeFor(100, 0.7, btcFee) - 1.05) < 1e-12); // the same on the other side of even
  assert.ok(Math.abs(feeFor(20, 0.5, altFee) - 0.05) < 1e-12); // 20 x 0.01 x 0.25
  assert.equal(feeFor(100, 0.5, { rate: 0.05, exponent: 2 }), 0.3125); // 100 x 0.05 x 0.0625
  assert.equal(feeFor(100, 0.5, noFee), 0);
});

test('a fill takes the cheapest offers first until the stake is spent', () => {
  const offers: Level[] = [{ price: 0.5, size: 10 }, { price: 0.52, size: 10 }, { price: 0.9, size: 1000 }];
  // 10 shares at 0.50 cost 5 dollars; the other 5 dollars buy 9.6154 shares at 0.52. The third offer is never touched.
  assert.deepEqual(fill(offers, 10, btcFee), {
    shares: 19.6154, cost: 10, price: 0.5098, top: 0.5,
    fee: 0.245, // 10 x 0.05 x 0.25, plus 9.6154 x 0.05 x 0.2496
  });
  // A stake the best offer covers pays the best price.
  assert.deepEqual(fill(offers, 4, noFee), { shares: 8, cost: 4, fee: 0, price: 0.5, top: 0.5 });
  // A stake that takes a level whole stops there.
  assert.deepEqual(fill(offers, 5, noFee), { shares: 10, cost: 5, fee: 0, price: 0.5, top: 0.5 });
});

test('no fill when the book cannot carry the trade', () => {
  assert.equal(fill([], 10, btcFee), null);
  assert.equal(fill([{ price: 0.5, size: 4 }], 10, btcFee), null); // 2 dollars of offers for a 10 dollar stake
  assert.equal(fill([{ price: 0.5, size: 10 }, { price: 0.51, size: 9.8 }], 10, btcFee), null); // two cents short
  // Polymarket takes no order under its minimum number of shares.
  const offers: Level[] = [{ price: 0.5, size: 100 }];
  assert.equal(fill(offers, 2, btcFee, 5), null); // 4 shares
  assert.equal(fill(offers, 2.5, btcFee, 5)?.shares, 5);
  assert.equal(fill(offers, 2, btcFee)?.shares, 4);
});

test('a share pays one dollar when its side wins and nothing when it loses', () => {
  const f = fill([{ price: 0.5, size: 10 }, { price: 0.52, size: 10 }], 10, btcFee)!;
  assert.deepEqual(settle(f, true), { payout: 19.6154, profit: 9.3704 }); // 19.6154 - 10 - 0.245
  assert.deepEqual(settle(f, false), { payout: 0, profit: -10.245 }); // the stake and the fee
  // At an even price with no fee, a win doubles the stake.
  assert.deepEqual(settle({ shares: 20, cost: 10, fee: 0 }, true), { payout: 20, profit: 10 });
});
