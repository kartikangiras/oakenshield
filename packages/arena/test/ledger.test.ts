import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger, summarize, writeAtomic } from '../src/ledger.ts';
import type { OpenLine, Phase, SettleLine } from '../src/ledger.ts';
import type { Asset, Side, Signals } from '../src/playbook.ts';

const signals: Signals = { ret_1m: 0, ret_5m: 0.1, ret_15m: 0, ret_60m: 0, btc_ret_5m: 0, btc_ret_15m: 0, streak: 1, range_15m: 0.3, volume_ratio: 1, hour_utc: 12 };
/** 2026-11-20 12:00 UTC. Window n opens n x 5 minutes later. */
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const iso = (t: number) => new Date(t * 1000).toISOString();

/** A ten dollar paper trade at 50 cents with a 12 cent fee. */
function open(asset: Asset, window: number, arm: string, side: Side = 'up', phase: Phase = 'experiment'): OpenLine {
  const start = T0 + 300 * window;
  return {
    t: 'open', at: iso(start - 20), slug: `${asset}-updown-5m-${start}`, asset, start, end: start + 300, condition: `0x${asset}${window}`,
    arm, phase, side, rule: arm === 'control' ? 0 : 1, signals, price: 0.5, top: 0.5, shares: 20, cost: 10, fee: 0.12,
  };
}
/** Settled `late` seconds after the window closed. A win pays 20 dollars. */
function settled(o: OpenLine, won: boolean, late = 20): SettleLine {
  const winner: Side = won ? o.side : o.side === 'up' ? 'down' : 'up';
  return { t: 'settle', at: iso(o.end + late), slug: o.slug, winner, won, payout: won ? 20 : 0, profit: won ? 9.88 : -10.12 };
}
const dir = () => mkdtempSync(join(tmpdir(), 'arena-ledger-'));

/** One of everything the runner writes: wins, a loss, an open trade, a void, a skip, a trade after the experiment. */
function story(ledger: Ledger) {
  const a = open('btc', 0, 'control'), b = open('eth', 0, 'agent_a', 'down'), c = open('sol', 1, 'control');
  const d = open('xrp', 1, 'agent_b'), e = open('doge', 1, 'agent_b'), f = open('bnb', 2, 'agent_a', 'up', 'after');
  for (const o of [a, b]) ledger.add(o);
  ledger.add({ t: 'skip', at: iso(a.start - 20), slug: `zec-updown-5m-${a.start}`, why: 'book too thin for the stake' });
  ledger.add(settled(b, false, 20));
  ledger.add(settled(a, true, 25));
  ledger.add({ t: 'reported', at: iso(a.end + 30), slugs: [a.slug] });
  for (const o of [c, d, e, f]) ledger.add(o);
  ledger.add(settled(c, false));
  ledger.add({ t: 'void', at: iso(e.end + 7 * 3600), slug: e.slug, why: 'Polymarket had not resolved the market after six hours' });
  ledger.add(settled(f, true));
  return { a, b, c, d, e, f };
}
const slugs = (trades: { slug: string }[]) => trades.map(t => t.slug).sort();

test('the ledger knows which trades wait for a market and which wait for Flagsmith', () => {
  const at = dir();
  const ledger = new Ledger(at);
  const { a, b, c, d, e, f } = story(ledger);
  assert.equal(ledger.trades.size, 6);
  assert.equal(ledger.skipped, 1);
  assert.deepEqual(slugs(ledger.pending()), [d.slug]); // e was given up on, the rest have settled
  // Settled and in the experiment, but not yet confirmed by Flagsmith. Not a (reported), not f (after the experiment).
  assert.deepEqual(slugs(ledger.unreported()), slugs([b, c]));
  assert.equal(ledger.trades.get(a.slug)?.reported, true);
  assert.equal(ledger.trades.get(a.slug)?.settle?.profit, 9.88);
  assert.equal(ledger.trades.get(e.slug)?.void?.why, 'Polymarket had not resolved the market after six hours');
  assert.equal(ledger.trades.get(f.slug)?.settle?.won, true);

  ledger.add({ t: 'reported', at: iso(c.end + 40), slugs: [b.slug, c.slug, 'eth-updown-5m-0'] }); // an unknown market is ignored
  assert.deepEqual(ledger.unreported(), []);
  rmSync(at, { recursive: true });
});

test('a ledger opened again reads the same state back from its file', () => {
  const at = dir();
  const first = new Ledger(at);
  const { b, c, d } = story(first);
  // One JSON line per thing that happened, in order.
  const text = readFileSync(join(at, 'trades.jsonl'), 'utf8');
  assert.equal(text.trim().split('\n').length, first.lines.length);
  assert.deepEqual(text.trim().split('\n').map(l => JSON.parse(l)), first.lines);

  // A crash can cut the last line short. It is dropped and the rest still counts.
  appendFileSync(join(at, 'trades.jsonl'), '{"t":"open","slug":"btc-updown-5m-17');
  const second = new Ledger(at);
  assert.deepEqual(second.lines, first.lines);
  assert.deepEqual([...second.trades], [...first.trades]);
  assert.equal(second.skipped, 1);
  assert.deepEqual(slugs(second.pending()), [d.slug]);
  assert.deepEqual(slugs(second.unreported()), slugs([b, c]));
  assert.deepEqual(new Ledger(dir()).lines, []); // no file yet: an empty ledger
  rmSync(at, { recursive: true });
});

test('the summary counts each arm, replays the settled markets in order and lists the newest trades first', () => {
  const at = dir();
  const ledger = new Ledger(at);
  const { a, b, c, d, f } = story(ledger);
  const now = new Date('2026-11-20T13:00:00.000Z');
  const state = summarize(ledger.trades.values(), ['control', 'agent_a', 'agent_b'], ledger.skipped, now);

  assert.deepEqual({ version: state.version, paper: state.paper, updated_at: state.updated_at, order: state.order }, { version: 1, paper: true, updated_at: now.toISOString(), order: ['control', 'agent_a', 'agent_b'] });
  assert.deepEqual(state.arms, {
    control: { markets: 2, settled: 2, won: 1, staked: 20, fees: 0.24, shares: 40, profit: -0.24 }, // +9.88 and -10.12
    agent_a: { markets: 1, settled: 1, won: 0, staked: 10, fees: 0.12, shares: 20, profit: -10.12 },
    agent_b: { markets: 1, settled: 0, won: 0, staked: 0, fees: 0, shares: 0, profit: 0 }, // one open; the void counts for nobody
  });
  // What traded once the experiment was over is kept apart from every arm.
  assert.deepEqual(state.after, { markets: 1, settled: 1, won: 1, staked: 10, fees: 0.12, shares: 20, profit: 9.88 });
  assert.deepEqual({ open: state.open, skipped: state.skipped, voided: state.voided }, { open: 1, skipped: 1, voided: 1 });

  // One character per settled market of the experiment, in the order they settled: arm index x 2, plus 1 for a win.
  // b (agent_a, lost) settled first, then a (control, won), then c (control, lost).
  assert.equal(state.replay, '210');
  assert.equal(state.replay.length, Object.values(state.arms).reduce((n, arm) => n + arm.settled, 0));

  // Running profit per arm, one point per window that has a settled trade.
  assert.deepEqual(state.curve, { at: [a.start, c.start], profit: { control: [9.88, -0.24], agent_a: [-10.12, -10.12], agent_b: [0, 0] } });

  // The newest market first; the void is left out.
  assert.deepEqual(state.feed.map(r => r.slug), [f.slug, d.slug, c.slug, b.slug, a.slug]);
  assert.deepEqual(state.feed[0], { slug: f.slug, asset: 'bnb', start: f.start, arm: 'agent_a', phase: 'after', side: 'up', rule: 1, price: 0.5, winner: 'up', won: true, profit: 9.88 });
  assert.deepEqual(state.feed[1], { slug: d.slug, asset: 'xrp', start: d.start, arm: 'agent_b', phase: 'experiment', side: 'up', rule: 1, price: 0.5 }); // still open
  assert.deepEqual(state.feed[3], { slug: b.slug, asset: 'eth', start: b.start, arm: 'agent_a', phase: 'experiment', side: 'down', rule: 1, price: 0.5, winner: 'up', won: false, profit: -10.12 });
  assert.deepEqual({ first: state.first, last: state.last }, { first: a.at, last: f.at });
  rmSync(at, { recursive: true });
});

test('a summary of nothing is empty, and the feed keeps the last sixty trades', () => {
  const empty = summarize([], ['control', 'agent_a']);
  assert.deepEqual(empty.arms, { control: { markets: 0, settled: 0, won: 0, staked: 0, fees: 0, shares: 0, profit: 0 }, agent_a: { markets: 0, settled: 0, won: 0, staked: 0, fees: 0, shares: 0, profit: 0 } });
  assert.deepEqual({ replay: empty.replay, feed: empty.feed, curve: empty.curve, open: empty.open }, { replay: '', feed: [], curve: { at: [], profit: { control: [], agent_a: [] } }, open: 0 });
  assert.equal('first' in empty, false);

  const many = Array.from({ length: 70 }, (_, i) => open('btc', i, i % 2 ? 'agent_a' : 'control'));
  const state = summarize(many, ['control', 'agent_a']);
  assert.equal(state.feed.length, 60);
  assert.equal(state.feed[0]!.slug, many[69]!.slug);
  assert.equal(state.feed[59]!.slug, many[10]!.slug);
  assert.equal(state.open, 70);
});

test('the state file is replaced whole', () => {
  const at = dir();
  const path = join(at, 'state.json');
  writeAtomic(path, { n: 1 });
  writeAtomic(path, { n: 2 });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { n: 2 });
  rmSync(at, { recursive: true });
});
