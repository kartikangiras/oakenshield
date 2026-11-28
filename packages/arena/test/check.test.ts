import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check } from '../src/check.ts';
import type { Trade } from '../src/ledger.ts';
import type { Asset, Signals } from '../src/playbook.ts';

const signals: Signals = { ret_1m: 0, ret_5m: 0.1, ret_15m: 0, ret_60m: 0, btc_ret_5m: 0, btc_ret_15m: 0, streak: 1, range_15m: 0.3, volume_ratio: 1, hour_utc: 12 };
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const iso = (t: number) => new Date(t * 1000).toISOString();
const ORDER = ['control', 'agent_a', 'agent_b'];

/** A settled ten dollar trade at 50 cents with a 12 cent fee, so it breaks even at 50.6% right calls. */
function trade(asset: Asset, window: number, arm: string, won: boolean, phase: Trade['phase'] = 'experiment'): Trade {
  const start = T0 + 300 * window;
  const slug = `${asset}-updown-5m-${start}`;
  return {
    t: 'open', at: iso(start - 50), slug, asset, start, end: start + 300, condition: `0x${asset}${window}`,
    arm, phase, side: 'up', rule: 0, signals, price: 0.5, top: 0.5, shares: 20, cost: 10, fee: 0.12,
    settle: { t: 'settle', at: iso(start + 320), slug, winner: won ? 'up' : 'down', won, payout: won ? 20 : 0, profit: won ? 9.88 : -10.12 },
  };
}

test('the check counts settled markets of the experiment per arm, and what each needed to break even', () => {
  const trades = [
    trade('btc', 0, 'control', true), trade('eth', 0, 'control', false), trade('sol', 0, 'agent_a', true),
    trade('btc', 1, 'agent_a', true), trade('eth', 1, 'agent_b', false),
    trade('xrp', 1, 'agent_a', false, 'after'), // traded after the experiment: not counted
    { ...trade('bnb', 1, 'agent_b', true), settle: undefined } as Trade, // still open
  ];
  const c = check(trades, ORDER, { agent_a: 0.9 }, 200, 'test', new Date(0));
  assert.equal(c.markets, 5);
  assert.equal(c.windows, 2);
  assert.deepEqual(c.arms.control, { markets: 2, won: 1, rate: 0.5, break_even: 0.506, profit: -0.24 });
  assert.deepEqual(c.arms.agent_a, { markets: 2, won: 2, rate: 1, break_even: 0.506, profit: 19.76 });
  assert.equal(c.against_control.agent_a!.diff, 0.5);
  assert.deepEqual(c.flagsmith, { agent_a: 0.9, agent_b: null });
  assert.deepEqual(check(trades, ORDER, { agent_a: 0.9 }, 200, 'test', new Date(0)), c, 'the same log and seed give the same numbers');
});

test('a playbook that is right everywhere beats the coin in every draw, and its twin in about half', () => {
  const trades: Trade[] = [];
  for (let w = 0; w < 40; w++) {
    trades.push(trade('btc', w, 'control', w % 2 === 0), trade('eth', w, 'agent_a', true), trade('sol', w, 'agent_b', w % 2 === 0));
  }
  const c = check(trades, ORDER, {}, 2000, 'test');
  assert.equal(c.against_control.agent_a!.chance_to_win, 1);
  assert.ok(c.against_control.agent_a!.low > 0);
  // Agent B is right in exactly the windows the coin is, so every draw is a tie.
  assert.equal(c.against_control.agent_b!.chance_to_win, 0.5);
  assert.equal(c.against_control.agent_b!.diff, 0);
});

test('markets that win and lose together within a window widen the interval', () => {
  const together: Trade[] = [], apart: Trade[] = [];
  const assets: Asset[] = ['btc', 'eth', 'sol', 'xrp'];
  for (let w = 0; w < 30; w++) {
    assets.forEach((a, i) => {
      // The same 60 wins out of 120 for the playbook: by whole windows, or spread evenly inside each.
      together.push(trade(a, w, 'agent_a', w % 2 === 0));
      apart.push(trade(a, w, 'agent_a', i % 2 === 0));
    });
    for (const list of [together, apart]) list.push(trade('doge', w, 'control', w % 2 === 1), trade('bnb', w, 'control', w % 2 === 0));
  }
  const width = (c: ReturnType<typeof check>) => c.against_control.agent_a!.high - c.against_control.agent_a!.low;
  const a = check(together, ORDER, {}, 2000, 'test'), b = check(apart, ORDER, {}, 2000, 'test');
  assert.equal(a.arms.agent_a!.rate, b.arms.agent_a!.rate);
  assert.ok(width(a) > width(b) + 0.1, `${width(a)} against ${width(b)}`);
});

test('an empty log gives an empty check', () => {
  const c = check([], ORDER);
  assert.equal(c.markets, 0);
  assert.deepEqual(c.against_control, {});
});
