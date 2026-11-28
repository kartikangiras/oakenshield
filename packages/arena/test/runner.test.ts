import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localDesk } from '../src/desk.ts';
import { Ledger } from '../src/ledger.ts';
import type { ArenaState, OpenLine } from '../src/ledger.ts';
import type { Asset, Signals } from '../src/playbook.ts';
import { run } from '../src/runner.ts';

const signals: Signals = { ret_1m: 0, ret_5m: 0.1, ret_15m: 0, ret_60m: 0, btc_ret_5m: 0, btc_ret_15m: 0, streak: 1, range_15m: 0.3, volume_ratio: 1, hour_utc: 12 };
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0) / 1000;
const iso = (t: number) => new Date(t * 1000).toISOString();
const ORDER = ['control', 'agent_a', 'agent_b'];
const COIN = '{"version":1,"kind":"coin","seed":"test"}';

/** A settled market Flagsmith knows about, so the runner has nothing left to do for it. */
function done(ledger: Ledger, asset: Asset, window: number, arm: string, won = true) {
  const start = T0 + 300 * window;
  const o: OpenLine = {
    t: 'open', at: iso(start - 50), slug: `${asset}-updown-5m-${start}`, asset, start, end: start + 300, condition: `0x${asset}${window}`,
    arm, phase: 'experiment', side: 'up', rule: 0, signals, price: 0.5, top: 0.5, shares: 20, cost: 10, fee: 0.12,
  };
  ledger.add(o);
  ledger.add({ t: 'settle', at: iso(o.end + 20), slug: o.slug, winner: won ? 'up' : 'down', won, payout: won ? 20 : 0, profit: won ? 9.88 : -10.12 });
  ledger.add({ t: 'reported', at: iso(o.end + 30), slugs: [o.slug] });
}

test('the runner opens nothing once every version has its sample, until the result is read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-runner-'));
  try {
    const ledger = new Ledger(dir);
    ORDER.forEach((arm, i) => { done(ledger, 'btc', i, arm); done(ledger, 'eth', i, arm); });
    const before = readFileSync(ledger.file, 'utf8');

    const stop = new AbortController();
    const said: string[] = [];
    await run({
      dir, desk: localDesk({ control: COIN, versions: {}, split: { control: 100 } }), order: ORDER,
      venue: { assets: ['btc'], stake: 10, max_price: 0.65 }, events: { placed: 'trade_placed', won: 'trade_won' },
      target: 2, decided: () => false, signal: stop.signal,
      // It holds before it looks anything up, so stopping here means no market was ever asked for.
      say: line => { said.push(line); stop.abort(); },
    });

    assert.match(said[0]!, /Every version has its 2 markets and Flagsmith has every outcome/);
    assert.match(said[0]!, /npm run arena -- verdict/);
    assert.equal(readFileSync(ledger.file, 'utf8'), before, 'no line was added');
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as ArenaState;
    assert.match(state.note!, /Nothing is traded until the result is read/);
    assert.equal(state.arms.agent_a!.markets, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the loss limit counts the last settled markets, and only those since a restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-ledger-'));
  try {
    const ledger = new Ledger(dir);
    assert.equal(ledger.lost(5), 0);
    done(ledger, 'btc', 0, 'control', false);
    done(ledger, 'btc', 1, 'agent_a', false);
    done(ledger, 'btc', 2, 'agent_b', true);
    assert.equal(ledger.lost(5), 10.36, 'two losses and a win');
    assert.equal(ledger.lost(1), -9.88, 'the newest market alone made money');
    ledger.add({ t: 'halt', at: iso(T0 + 1000), lost: 10.36, max_loss: 10, over: 5 });
    ledger.add({ t: 'resume', at: iso(T0 + 1100), halted_at: iso(T0 + 1000), by: 'tester' });
    assert.equal(ledger.lost(5), 0, 'nothing has settled since the restart');
    done(ledger, 'btc', 4, 'control', false);
    assert.equal(ledger.lost(5), 10.12);
    const again = new Ledger(dir);
    assert.equal(again.halted, null);
    assert.equal(again.lost(5), 10.12, 'a runner that starts again reads the same loss');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the loss limit stops every version until a person restarts the arena', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'arena-breaker-'));
  try {
    const ledger = new Ledger(dir);
    ORDER.forEach((arm, i) => done(ledger, 'btc', i, arm, false));
    const risk = { max_loss: 30, over: 100 };
    const common = {
      dir, desk: localDesk({ control: COIN, versions: {}, split: { control: 100 } }), order: ORDER,
      venue: { assets: ['btc' as Asset], stake: 10, max_price: 0.65 }, events: { placed: 'trade_placed', won: 'trade_won' }, risk,
    };
    const lines = () => readFileSync(ledger.file, 'utf8').trim().split('\n').map(l => JSON.parse(l) as { t: string; lost?: number; by?: string });

    // Three losses are 30.36 dollars: over the limit before the runner has looked at a single market.
    let stop = new AbortController();
    const said: string[] = [];
    await run({ ...common, restarted: () => null, signal: stop.signal, say: line => { said.push(line); stop.abort(); } });
    assert.match(said[0]!, /loss limit stopped every version/);
    assert.match(said[0]!, /npm run arena -- resume/);
    assert.deepEqual(lines().slice(-2).map(l => l.t), ['limit', 'halt']);
    assert.equal(lines().at(-1)!.lost, 30.36);
    let state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as ArenaState;
    assert.equal(typeof state.risk!.halted_at, 'string');
    assert.match(state.note!, /Nothing is traded until a person restarts the arena/);

    // Starting the runner again does not clear it, and neither does a higher limit.
    stop = new AbortController();
    said.length = 0;
    await run({ ...common, risk: { max_loss: 5000, over: 100 }, restarted: () => null, signal: stop.signal, say: line => { said.push(line); stop.abort(); } });
    assert.match(said[0]!, /loss limit stopped every version/);
    assert.equal(lines().filter(l => l.t === 'halt').length, 1);
    assert.equal(lines().filter(l => l.t === 'open').length, 3, 'nothing was opened while it was stopped');

    // A person's word for this halt does.
    stop = new AbortController();
    said.length = 0;
    const haltedAt = new Ledger(dir).halted!.at;
    await run({ ...common, restarted: at => (at === haltedAt ? 'tester' : null), signal: stop.signal, say: line => { said.push(line); stop.abort(); } });
    assert.match(said[0]!, /Restarted by tester/);
    assert.equal(lines().at(-1)!.t, 'resume');
    state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as ArenaState;
    assert.equal(state.risk!.halted_at, undefined);
    assert.equal(state.risk!.lost, 0);
    assert.equal(state.note, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
