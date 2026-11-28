import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOOKBACK_MINUTES, WINDOW, signalsAt, situations } from '../src/signals.ts';
import type { Candle } from '../src/signals.ts';

/** 2026-11-20 12:00 UTC. Candle i is the minute that starts i minutes later. */
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
/** A market that opens at 13:05. */
const START = T0 + 65 * 60;
/** The newest candle a signal may read: it closes one minute before the market opens. */
const J = 63;

/** `n` minutes in which nothing happens: one price, one volume. */
const quiet = (n: number, price = 100, volume = 10): Candle[] =>
  Array.from({ length: n }, (_, i) => ({ t: T0 + 60 * i, o: price, h: price, l: price, c: price, v: volume }));
/** Moves one candle's close, and its high or low with it. `back` counts minutes before the newest readable one. */
const close = (candles: Candle[], back: number, price: number) => {
  const c = candles[J - back]!;
  c.c = price; c.h = Math.max(c.h, price); c.l = Math.min(c.l, price);
};
const without = (candles: Candle[], back: number) => candles.filter(c => c.t !== T0 + 60 * (J - back));

test('a quiet hour gives flat signals', () => {
  const candles = quiet(70);
  assert.deepEqual(signalsAt(candles, candles, START), {
    ret_1m: 0, ret_5m: 0, ret_15m: 0, ret_60m: 0, btc_ret_5m: 0, btc_ret_15m: 0,
    streak: 0, range_15m: 0, volume_ratio: 1, hour_utc: 13,
  });
  assert.equal(signalsAt(candles, candles, START + 55 * 60), null); // 14:00 needs minutes the series does not have
});

test('the returns compare the newest closed minute with the closes 1, 5, 15 and 60 minutes before it', () => {
  const own = quiet(70);
  close(own, 0, 102); close(own, 1, 101); close(own, 15, 96); close(own, 60, 85);
  const btc = quiet(70, 50_000);
  close(btc, 0, 50_500); close(btc, 5, 50_000); close(btc, 15, 40_400);
  const s = signalsAt(own, btc, START)!;
  assert.equal(s.ret_1m, 0.9901); // 102 / 101
  assert.equal(s.ret_5m, 2); // 102 / 100
  assert.equal(s.ret_15m, 6.25); // 102 / 96
  assert.equal(s.ret_60m, 20); // 102 / 85
  assert.equal(s.btc_ret_5m, 1); // 50,500 / 50,000
  assert.equal(s.btc_ret_15m, 25); // 50,500 / 40,400
  // A map by minute reads the same as the list.
  assert.deepEqual(signalsAt(new Map(own.map(c => [c.t, c])), new Map(btc.map(c => [c.t, c])), START), s);
});

test('the streak counts five minute steps in a row that went the way of the last one', () => {
  const rising = quiet(70);
  close(rising, 0, 103); close(rising, 5, 102); close(rising, 10, 101); close(rising, 15, 100); close(rising, 20, 100.5);
  assert.equal(signalsAt(rising, rising, START)!.streak, 3); // the fourth step back was a fall

  const falling = quiet(70);
  close(falling, 0, 97); close(falling, 5, 98);
  assert.equal(signalsAt(falling, falling, START)!.streak, -2); // the third step back did not move

  const unchanged = quiet(70);
  close(unchanged, 5, 100); close(unchanged, 10, 90);
  assert.equal(signalsAt(unchanged, unchanged, START)!.streak, 0); // an unchanged last step ends it at once

  // An hour that only rises is twelve steps, and the count stops there.
  const ramp = quiet(140).map((c, i) => ({ ...c, o: 100 + i, h: 101 + i, l: 100 + i, c: 101 + i }));
  assert.equal(signalsAt(ramp, ramp, START + 60 * 60)!.streak, 12);
});

test('the range is the highest high minus the lowest low of the last fifteen closed minutes', () => {
  const candles = quiet(70);
  candles[J - 3]!.h = 101.5;
  candles[J - 14]!.l = 99;
  candles[J - 15]!.h = 250; // a sixteenth minute back does not count
  candles[J + 1]!.l = 1; // nor does a minute that has not closed in time
  assert.equal(signalsAt(candles, candles, START)!.range_15m, 2.5); // (101.5 - 99) / 100
});

test('the volume ratio sets the last five minutes against the average five minutes of the hour', () => {
  const burst = quiet(70);
  for (let back = 0; back < 5; back++) burst[J - back]!.v = 30;
  assert.equal(signalsAt(burst, burst, START)!.volume_ratio, 2.5714); // 150 / ((55 x 10 + 150) / 12)
  const silent = quiet(70, 100, 0);
  assert.equal(signalsAt(silent, silent, START)!.volume_ratio, 1); // nothing traded: call it normal
});

test('a missing minute means no signals, for the asset or for bitcoin', () => {
  const candles = quiet(70);
  assert.ok(signalsAt(candles, candles, START));
  assert.equal(signalsAt(without(candles, 0), candles, START), null);
  assert.equal(signalsAt(without(candles, 30), candles, START), null); // the hour's volume needs every minute
  assert.equal(signalsAt(without(candles, 60), candles, START), null); // the close an hour back
  assert.ok(signalsAt(without(candles, 61), candles, START)); // nothing reads further back
  assert.equal(signalsAt(candles, without(candles, 15), START), null);
  assert.ok(signalsAt(candles, without(candles, 30), START)); // of bitcoin only three closes are read
  // The oldest minute read starts LOOKBACK_MINUTES before the market opens.
  assert.equal((START - candles[J - 60]!.t) / 60, LOOKBACK_MINUTES);
});

test('nothing later than a minute before the open changes the signals', () => {
  const own = quiet(70);
  close(own, 0, 102); close(own, 7, 99);
  const before = signalsAt(own, own, START);
  // The minute that is still trading when the call is made, and everything after it.
  const later = own.map((c, i) => (i > J ? { ...c, o: 500, h: 900, l: 1, c: 700, v: 9999 } : c));
  assert.deepEqual(signalsAt(later, later, START), before);
  // The minute before that one is read.
  const changed = own.map((c, i) => (i === J ? { ...c, c: 104 } : c));
  assert.notDeepEqual(signalsAt(changed, changed, START), before);
});

test('past markets are rebuilt with the signals a trader would have had, and a tie counts as up', () => {
  const own = quiet(200);
  // The 13:10 market closes below its open; every other market ends where it started.
  for (let i = 70; i < 75; i++) own[i] = { ...own[i]!, c: 99, l: 99 };
  const btc = quiet(200, 50_000);
  const from = START, to = START + 6 * WINDOW;
  const rows = situations('eth', own, btc, from, to);
  assert.deepEqual(rows.map(r => r.start), [0, 1, 2, 3, 4, 5].map(k => START + k * WINDOW));
  assert.ok(rows.every(r => r.asset === 'eth'));
  // 13:05 is a tie: up. 13:10 opens at 100 and closes at 99: down. 13:15 opens at 99 and closes at 100: up.
  assert.deepEqual(rows.map(r => r.up), [true, false, true, true, true, true]);
  for (const r of rows) assert.deepEqual(r.signals, signalsAt(own, btc, r.start));
  assert.equal(rows[2]!.signals.ret_5m, -1); // by 13:15 the fall is in the signals

  // A market needs its whole five minutes inside the range, and starts on the grid.
  assert.equal(situations('eth', own, btc, from + 1, to).length, 5);
  assert.equal(situations('eth', own, btc, from, to - 1).length, 5);
  // Without the closing price there is no market to rebuild.
  const cut = own.filter(c => c.t !== START + WINDOW - 60);
  assert.equal(situations('eth', cut, btc, from, to).some(r => r.start === START), false);
});
