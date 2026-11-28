import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, agreement, decide, describe, flip, parsePlaybook, parseTrader, review, tape } from '../src/playbook.ts';
import type { Asset, Playbook, Signals, Situation } from '../src/playbook.ts';

const flat: Signals = { ret_1m: 0, ret_5m: 0, ret_15m: 0, ret_60m: 0, btc_ret_5m: 0, btc_ret_15m: 0, streak: 0, range_15m: 0.3, volume_ratio: 1, hour_utc: 12 };
const sig = (over: Partial<Signals> = {}): Signals => ({ ...flat, ...over });
const START = 1_764_000_000;
/** One past market: its signals, and whether it resolved up. Each gets its own five minutes. */
const past = (rows: [Partial<Signals>, boolean, Asset?][]): Situation[] =>
  rows.map(([over, up, asset = 'btc'], i) => ({ asset, start: START + 300 * i, signals: sig(over), up }));

const cond = (signal: string, op: string, value: number) => ({ signal, op, value });
const written = (rules: unknown[], otherwise: unknown = 'down', name = 'Test playbook') => ({ name, rules, otherwise });
const read = (value: unknown): Playbook => {
  const { playbook, problems } = parsePlaybook(value);
  assert.deepEqual(problems, []);
  return playbook!;
};
const codes = (value: unknown) => {
  const { playbook, problems } = parsePlaybook(value);
  assert.equal(playbook, null);
  return problems.map(p => p.code);
};

const withTheMove = read(written([{ when: [cond('ret_5m', '>', 0)], side: 'up' }]));
const againstTheMove = read(written([{ when: [cond('ret_5m', '>', 0)], side: 'down' }], 'up'));

test('a playbook an agent wrote is read with only the fields the language has', () => {
  const playbook = read({
    name: '  Ride the burst  ', otherwise: 'down', notes: 'not part of the language',
    rules: [{ when: [cond('ret_5m', '>', 0.1), { ...cond('volume_ratio', '>=', 1.5), weight: 3 }], side: 'up', assets: ['btc', 'eth', 'btc'], why: ' Volume backs the move. ', size: 2 }],
  });
  assert.deepEqual(playbook, {
    version: 1, kind: 'playbook', name: 'Ride the burst', otherwise: 'down',
    rules: [{ when: [cond('ret_5m', '>', 0.1), cond('volume_ratio', '>=', 1.5)], side: 'up', assets: ['btc', 'eth'], why: 'Volume backs the move.' }],
  });
  // The flag serves the playbook as a string, so that reads too.
  assert.deepEqual(parsePlaybook(JSON.stringify(playbook)).playbook, playbook);
});

test('the referee names what is wrong with a playbook that is not in the language', () => {
  const rule = { when: [cond('ret_5m', '>', 0)], side: 'up' };
  assert.deepEqual(codes('not json'), ['shape']);
  assert.deepEqual(codes([rule]), ['shape']);
  assert.deepEqual(codes(written([{ when: [cond('rsi_14', '>', 70)], side: 'up' }])), ['signal']);
  assert.deepEqual(codes(written([{ when: [cond('ret_5m', '==', 0)], side: 'up' }])), ['op']);
  assert.deepEqual(codes(written([{ when: [cond('ret_5m', '>', 10.5)], side: 'up' }])), ['value']);
  assert.deepEqual(codes(written([{ when: [{ signal: 'streak', op: '>', value: '2' }], side: 'up' }])), ['value']);
  assert.deepEqual(codes(written(Array.from({ length: LIMITS.rules + 1 }, () => rule))), ['rules']);
  assert.deepEqual(codes(written([])), ['rules']);
  assert.deepEqual(codes(written([{ when: Array.from({ length: LIMITS.conditions + 1 }, () => cond('ret_5m', '>', 0)), side: 'up' }])), ['when']);
  assert.deepEqual(codes(written([{ when: [cond('ret_5m', '>', 0)], side: 'long' }])), ['side']);
  assert.deepEqual(codes(written([rule], 'hold')), ['otherwise']);
  assert.deepEqual(codes(written([{ ...rule, assets: ['btc', 'ada'] }])), ['assets']);
  assert.deepEqual(codes(written([rule], 'down', 'x'.repeat(LIMITS.name + 1))), ['name']);
  assert.deepEqual(codes(written(['up'])), ['rule']);
  // Every problem is reported at once, so one repair can fix them all.
  assert.deepEqual(codes(written([{ when: [cond('rsi_14', '>', 70)], side: 'long' }], 'hold', '')), ['name', 'otherwise', 'side', 'signal']);
});

test('whatever the flag serves is a trader, or nothing trades', () => {
  const coin = { version: 1, kind: 'coin', seed: 'published-seed' };
  assert.deepEqual(parseTrader(JSON.stringify(withTheMove)), withTheMove);
  assert.deepEqual(parseTrader(withTheMove), withTheMove);
  assert.deepEqual(parseTrader(coin), coin);
  assert.deepEqual(parseTrader(JSON.stringify({ kind: 'coin', seed: 'published-seed', extra: true })), coin);
  assert.equal(parseTrader({ kind: 'coin' }), null);
  assert.equal(parseTrader({ kind: 'coin', seed: '' }), null);
  assert.equal(parseTrader('not json'), null);
  assert.equal(parseTrader(''), null);
  assert.equal(parseTrader(42), null);
  assert.equal(parseTrader(null), null);
  assert.equal(parseTrader([withTheMove]), null);
  assert.equal(parseTrader(written([{ when: [cond('rsi_14', '>', 70)], side: 'up' }])), null);
});

test('the first rule that holds makes the call, and otherwise answers when none does', () => {
  const playbook = read(written([
    { when: [cond('ret_5m', '>', 0.1), cond('volume_ratio', '>=', 1.5)], side: 'up' },
    { when: [cond('ret_5m', '>', 0)], side: 'down' },
    { when: [cond('streak', '<=', -2)], side: 'up' },
    { when: [cond('ret_15m', '<', -1)], side: 'up' },
  ], 'down'));
  const call = (over: Partial<Signals>) => decide(playbook, sig(over), 'btc', 'btc-updown-5m-0');
  assert.deepEqual(call({ ret_5m: 0.2, volume_ratio: 1.5 }), { side: 'up', rule: 1 }); // rule 2 holds too
  assert.deepEqual(call({ ret_5m: 0.2, volume_ratio: 1.49 }), { side: 'down', rule: 2 }); // every condition has to hold
  assert.deepEqual(call({ ret_5m: 0.1, volume_ratio: 9 }), { side: 'down', rule: 2 }); // > is strict
  assert.deepEqual(call({ streak: -2 }), { side: 'up', rule: 3 });
  assert.deepEqual(call({ streak: -1, ret_15m: -1.01 }), { side: 'up', rule: 4 });
  assert.deepEqual(call({ streak: -1, ret_15m: -1 }), { side: 'down', rule: 0 }); // < is strict
});

test('a rule with assets is skipped for every other asset', () => {
  const playbook = read(written([
    { when: [cond('ret_5m', '>', 0)], side: 'up', assets: ['btc', 'eth'] },
    { when: [cond('ret_5m', '>', 0)], side: 'down' },
  ], 'up'));
  const rising = sig({ ret_5m: 0.3 });
  assert.deepEqual(decide(playbook, rising, 'btc', 'btc-updown-5m-0'), { side: 'up', rule: 1 });
  assert.deepEqual(decide(playbook, rising, 'eth', 'eth-updown-5m-0'), { side: 'up', rule: 1 });
  assert.deepEqual(decide(playbook, rising, 'sol', 'sol-updown-5m-0'), { side: 'down', rule: 2 });
});

test('the coin gives one market the same side every time, and both sides over many markets', () => {
  const markets = Array.from({ length: 400 }, (_, i) => `btc-updown-5m-${START + 300 * i}`);
  const sides = markets.map(m => flip('seed-one', m));
  assert.deepEqual(markets.map(m => flip('seed-one', m)), sides);
  const up = sides.filter(s => s === 'up').length / sides.length;
  assert.ok(up > 0.4 && up < 0.6, `the coin said up ${up} of the time`);
  // The seed is the whole coin: another seed is another sequence.
  assert.ok(markets.some(m => flip('seed-two', m) !== flip('seed-one', m)));
  // As a trader it ignores the signals and never names a rule.
  const coin = parseTrader({ kind: 'coin', seed: 'seed-one' })!;
  assert.deepEqual(decide(coin, sig({ ret_5m: 9 }), 'btc', markets[0]!), { side: sides[0], rule: 0 });
  assert.deepEqual(decide(coin, sig({ ret_5m: -9 }), 'btc', markets[0]!), { side: sides[0], rule: 0 });
});

test('a tape counts every call by the rule that made it, with otherwise last', () => {
  const playbook = read(written([
    { when: [cond('ret_5m', '>', 0)], side: 'up' },
    { when: [cond('streak', '<=', -2)], side: 'down' },
  ], 'down'));
  const markets = past([
    [{ ret_5m: 0.2 }, true], // rule 1, right
    [{ ret_5m: 0.3 }, false], // rule 1, wrong
    [{ ret_5m: -0.1, streak: -2 }, false], // rule 2, right
    [{ ret_5m: -0.1 }, true], // otherwise, wrong
    [{ ret_5m: -0.2, streak: 1 }, false], // otherwise, right
  ]);
  assert.deepEqual(tape(playbook, markets), {
    markets: 5, right: 3, rate: 0.6, up: 0.4,
    rules: [{ rule: 1, fired: 2, right: 1 }, { rule: 2, fired: 1, right: 1 }, { rule: 0, fired: 2, right: 1 }],
  });
  assert.deepEqual(tape(playbook, []), { markets: 0, right: 0, rate: 0, up: 0, rules: [{ rule: 1, fired: 0, right: 0 }, { rule: 2, fired: 0, right: 0 }, { rule: 0, fired: 0, right: 0 }] });

  // The coin has no rules: every flip is counted under "otherwise".
  const coin = tape({ version: 1, kind: 'coin', seed: 'seed-one' }, markets);
  assert.equal(coin.rules.length, 1);
  assert.deepEqual({ rule: coin.rules[0]!.rule, fired: coin.rules[0]!.fired }, { rule: 0, fired: 5 });
  assert.equal(coin.right, coin.rules[0]!.right);
});

test('the referee rejects a playbook that takes one side, and a rule that almost never fires', () => {
  // Twenty markets: half after a rise, half after a fall.
  const markets = past(Array.from({ length: 20 }, (_, i): [Partial<Signals>, boolean] => [{ ret_5m: i % 2 ? 0.2 : -0.2 }, i % 3 === 0]));
  assert.deepEqual(review(withTheMove, markets), []);

  const alwaysUp = read(written([{ when: [cond('range_15m', '>=', 0)], side: 'up' }]));
  const oneSided = review(alwaysUp, markets);
  assert.deepEqual(oneSided.map(p => p.code), ['one_sided']);
  assert.match(oneSided[0]!.message, /said up 100% of the time/);

  // Each side needs its share of the calls. On a hundred markets the limit is a whole number of them.
  const edge = Math.round(LIMITS.minSideShare * 100);
  const rises = (n: number) => past(Array.from({ length: 100 }, (_, i): [Partial<Signals>, boolean] => [{ ret_5m: i < n ? 0.2 : -0.2 }, true]));
  assert.deepEqual(review(withTheMove, rises(edge - 1)).map(p => p.code), ['one_sided']);
  assert.match(review(withTheMove, rises(edge - 1))[0]!.message, new RegExp(`said down ${101 - edge}% of the time`));
  assert.deepEqual(review(withTheMove, rises(edge)), []);
  assert.deepEqual(review(withTheMove, rises(101 - edge)).map(p => p.code), ['one_sided']);

  // A rule has to fire often enough to be judged: one time too few is dead weight.
  const streaks = (n: number) => past(Array.from({ length: 100 }, (_, i): [Partial<Signals>, boolean] => [{ ret_5m: i % 2 ? 0.2 : -0.2, streak: i < n ? 3 : 0 }, true]));
  const twoRules = read(written([{ when: [cond('streak', '>=', 3)], side: 'down' }, { when: [cond('ret_5m', '>', 0)], side: 'up' }]));
  const dead = review(twoRules, streaks(LIMITS.minRuleFires - 1));
  assert.deepEqual(dead.map(p => p.code), ['dead_rule']);
  assert.match(dead[0]!.message, new RegExp(`^Rule 1 fired ${LIMITS.minRuleFires - 1} times in 100 past markets`));
  assert.deepEqual(review(twoRules, streaks(LIMITS.minRuleFires)), []);
  // A rule shadowed by an earlier one never fires at all.
  const shadowed = read(written([{ when: [cond('ret_5m', '>', 0)], side: 'up' }, { when: [cond('ret_5m', '>', 5)], side: 'down' }]));
  assert.match(review(shadowed, markets)[0]!.message, /^Rule 2 fired 0 times in 20 past markets/);

  // With no past markets there is nothing to judge it on.
  assert.deepEqual(review(alwaysUp, []), []);
});

test('agreement is the share of markets on which two traders make the same call', () => {
  const markets = past([[{ ret_5m: 0.2 }, true], [{ ret_5m: -0.2 }, false], [{ ret_5m: 0.4, ret_15m: 1 }, true], [{ ret_5m: -0.4, ret_15m: 1 }, false]]);
  assert.equal(agreement(withTheMove, withTheMove, markets), 1);
  assert.equal(agreement(withTheMove, againstTheMove, markets), 0);
  // Up on a quarter hour rise: the same call as "with the move" on markets 2 and 3 only.
  const slower = read(written([{ when: [cond('ret_15m', '>', 0)], side: 'up' }]));
  assert.equal(agreement(withTheMove, slower, markets), 0.5);
  assert.equal(agreement(withTheMove, againstTheMove, []), 0);
});

test('a trader is described one line per rule', () => {
  const playbook = read(written([
    { when: [cond('ret_5m', '>', 0.1), cond('streak', '>=', 2)], side: 'up', assets: ['btc', 'eth'], why: 'Two rises in a row.' },
    { when: [cond('volume_ratio', '<', 0.5)], side: 'down' },
  ], 'down'));
  assert.deepEqual(describe(playbook), [
    '1. [btc, eth] ret_5m > 0.1 and streak >= 2 -> up  (Two rises in a row.)',
    '2. volume_ratio < 0.5 -> down',
    'otherwise -> down',
  ]);
  assert.deepEqual(describe({ version: 1, kind: 'coin', seed: 'seed-one' }), ['A coin flip per market (seed "seed-one").']);
});
