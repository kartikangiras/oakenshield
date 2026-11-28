import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Ask } from '@oakenshield/duel';
import { debate, planOf } from '../src/debate.ts';
import type { Brief } from '../src/agents.ts';
import { factSheet } from '../src/history.ts';
import type { Past } from '../src/history.ts';
import { agreement, parsePlaybook, parseTrader, tape } from '../src/playbook.ts';
import type { Asset, Situation } from '../src/playbook.ts';
import { situations } from '../src/signals.ts';
import type { Candle } from '../src/signals.ts';

const brief: Brief = {
  name: 'Test arena', flag: 'trader', environment: 'Arena', goal: 'A playbook calls the direction more often than a coin.',
  event: { key: 'trade_won', name: 'Trade won' }, guardrails: [{ key: 'trade_placed', name: 'Trade placed' }],
  watch: [{ key: 'paper_profit', name: 'Paper profit per market', aggregation: 'mean' }], placed: 'trade_placed',
  venue: { assets: ['btc', 'eth'], stake: 10, max_price: 0.6, about: 'Five minute markets on two assets.' },
  coin: { seed: 'test-seed' }, past: { hours: 16, held_hours: 4 },
  rule: { min_per_arm: 100, win_above: 0.95, harm_below: 0.05 }, split: { agent_a: 33, agent_b: 33 },
};

/** 2026-11-20 00:00 UTC. */
const T0 = Date.UTC(2026, 10, 20) / 1000;
const LEAD = 65 * 60;
/** A price that wanders: the same seed always gives the same minutes. No network, no real market. */
function wander(seed: number, minutes: number, price: number): Candle[] {
  let x = seed;
  const next = () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  return Array.from({ length: minutes }, (_, i) => {
    const o = price;
    price *= 1 + (next() - 0.5) * 0.002;
    return { t: T0 + 60 * i, o, h: Math.max(o, price), l: Math.min(o, price), c: price, v: 5 + next() * 20 };
  });
}
/** Sixteen hours of markets on two assets; the newest four hours are held back from the agents. */
const past: Past = (() => {
  const minutes = 65 + brief.past.hours * 60;
  const from = T0 + LEAD, to = T0 + minutes * 60, cut = to - brief.past.held_hours * 3600;
  const btc = wander(7, minutes, 90_000);
  const prices: [Asset, Candle[]][] = [['btc', btc], ['eth', wander(11, minutes, 3_000)]];
  const all: Situation[] = prices.flatMap(([asset, own]) => situations(asset, own, btc, from, to)).sort((a, b) => a.start - b.start || a.asset.localeCompare(b.asset));
  return { from, cut, to, seen: all.filter(s => s.start < cut), held: all.filter(s => s.start >= cut) };
})();

const rule = (signal: string, side: string) => [{ when: [{ signal, op: '>', value: 0 }], side, why: 'The last move.' }];
/** With the move, or against it. The two are opposite calls on every market. */
const withMove = (name: string, signal = 'ret_5m') => ({ name, rules: rule(signal, 'up'), otherwise: 'down' });
const againstMove = (name: string, signal = 'ret_5m') => ({ name, rules: rule(signal, 'down'), otherwise: 'up' });
/** Valid in the language, but it says up in every market: the referee's second look rejects it. */
const alwaysUp = { name: 'Always up', rules: [{ when: [{ signal: 'range_15m', op: '>=', value: 0 }], side: 'up' }], otherwise: 'down' };
/** Not in the language at all. */
const unreadable = { name: 'RSI', rules: [{ when: [{ signal: 'rsi_14', op: '>', value: 70 }], side: 'down' }], otherwise: 'up' };
const read = (value: unknown) => parsePlaybook(value).playbook!;

const reply = (value: unknown) => ({ text: '```json\n' + JSON.stringify(value) + '\n```', ms: 10, tokens: { in: 100, out: 20 }, cost: 0.001 });
const who = (system: string) => (system.includes('You are Agent A') ? 'A' : 'B');

/** A model that plays both agents from a script: `answers[agent][kind of question]`. */
function scripted(answers: Record<string, Record<string, unknown>>): Ask {
  return async (system, prompt) => {
    const kind = prompt.includes('The referee rejected') ? 'repair' : prompt.includes('Cross-examine') ? 'attack' : prompt.includes('You may revise') ? 'revise' : 'propose';
    return reply(answers[who(system)]![kind]);
  };
}
const fair = (name: string, playbook: typeof withMove) => ({
  propose: { playbook: playbook(`${name} first`), hypothesis: `If ${name}`, why: 'Because.' },
  attack: { attacks: ['Rule 1 is noise.', 'It ignores volume.'], concedes: 'It is simple.' },
  revise: { playbook: playbook(`${name} revised`, 'ret_15m'), changed: 'A slower signal.', hypothesis: `If ${name}, revised`, predicts: { control: 0.5, agent_a: 0.54, agent_b: 0.52 } },
});
const A = fair('A', withMove), B = fair('B', againstMove);

test('the synthetic past has a few hundred markets that went both ways', () => {
  assert.equal(past.seen.length, 2 * 12 * 12);
  assert.equal(past.held.length, 2 * 4 * 12);
  for (const rows of [past.seen, past.held]) {
    const up = rows.filter(s => s.up).length / rows.length;
    assert.ok(up > 0.3 && up < 0.7, `up won ${up}`);
  }
  assert.ok(past.seen.every(s => s.start < past.cut) && past.held.every(s => s.start >= past.cut));
});

test('both agents propose, attack, revise and predict; the revisions enter the experiment', async () => {
  const record = await debate(scripted({ A, B }), brief, past, 'stub');
  assert.equal(record.usage.calls, 6);
  assert.deepEqual(record.usage.tokens, { in: 600, out: 120 });
  assert.equal(record.usage.cost, 0.006);
  assert.deepEqual({ name: record.name, model: record.model, brief: record.brief, steps: record.steps }, { name: 'Test arena', model: 'stub', brief, steps: [] });

  // What the agents were told about, and what was kept from them.
  assert.equal(record.facts, factSheet(past.seen, past.from, past.cut));
  assert.deepEqual({ from: record.past.from, cut: record.past.cut, to: record.past.to, seen: record.past.seen, held: record.past.held }, { from: past.from, cut: past.cut, to: past.to, seen: 288, held: 96 });
  assert.equal(record.past.up_held, Math.round((past.held.filter(s => s.up).length / 96) * 1000) / 1000);

  assert.equal(record.proposals.agent_a?.playbook?.name, 'A first');
  assert.equal(record.proposals.agent_a?.repaired, undefined);
  assert.deepEqual(record.proposals.agent_b?.seen, tape(read(againstMove('B first')), past.seen));
  assert.equal(record.attacks.agent_a?.attacks.length, 2);
  assert.equal(record.attacks.agent_b?.concedes, 'It is simple.');
  assert.equal(record.revisions.agent_a?.changed, 'A slower signal.');

  const a = record.finalists.agent_a!, b = record.finalists.agent_b!;
  assert.deepEqual({ by: a.by, from: a.from, hypothesis: a.hypothesis }, { by: 'Agent A', from: 'revision', hypothesis: 'If A, revised' });
  assert.deepEqual(a.playbook, read(withMove('A revised', 'ret_15m')));
  assert.deepEqual(b.playbook, read(againstMove('B revised', 'ret_15m')));
  assert.deepEqual(a.predicts, { control: 0.5, agent_a: 0.54, agent_b: 0.52 });
  // The referee's score: on the markets the agents saw, and on the ones they never did.
  assert.deepEqual(a.seen, tape(a.playbook, past.seen));
  assert.deepEqual(a.held, tape(a.playbook, past.held));
  assert.equal(a.held.markets, 96);
  // Opposite playbooks never agree, and between them they are right on every market.
  assert.equal(record.agreement, 0);
  assert.equal(a.held.right + b.held.right, 96);

  assert.deepEqual(record.coin.trader, { version: 1, kind: 'coin', seed: 'test-seed' });
  assert.deepEqual(record.coin.held, tape(record.coin.trader, past.held));
  assert.equal(record.coin.seen.markets, 288);
});

test('the plan carries the coin as control and each finalist as a version, all as strings the runner can read', async () => {
  const record = await debate(scripted({ A, B }), brief, past, 'stub');
  const plan = planOf(record, 7) as {
    project: number; control: unknown; versions: Record<string, { by: string; hypothesis: string; predicts?: unknown; value: unknown }>;
    split: unknown; watch: unknown; protect: unknown; goal: unknown; guardrails: unknown; rule: unknown;
    flag: unknown; environment: unknown; create_environment: unknown; hypothesis: unknown;
  };
  assert.equal(plan.project, 7);
  // The skill's script takes the control value as it is, so it has to be a string already.
  assert.equal(typeof plan.control, 'string');
  assert.deepEqual(parseTrader(plan.control), record.coin.trader);
  assert.deepEqual(Object.keys(plan.versions), ['agent_a', 'agent_b']);
  for (const k of ['agent_a', 'agent_b'] as const) {
    assert.equal(typeof plan.versions[k]!.value, 'string');
    assert.deepEqual(parseTrader(plan.versions[k]!.value), record.finalists[k]!.playbook);
    assert.deepEqual(plan.versions[k]!.predicts, { control: 0.5, agent_a: 0.54, agent_b: 0.52 });
  }
  assert.deepEqual({ by: plan.versions.agent_a!.by, hypothesis: plan.versions.agent_a!.hypothesis }, { by: 'Agent A (momentum)', hypothesis: 'If A, revised' });
  assert.equal(plan.versions.agent_b!.by, 'Agent B (reversal)');
  assert.deepEqual(plan.split, { agent_a: 33, agent_b: 33 });
  assert.deepEqual(plan.goal, { event: 'trade_won', name: 'Trade won' });
  assert.deepEqual(plan.guardrails, [{ event: 'trade_placed', name: 'Trade placed' }]);
  assert.deepEqual(plan.watch, [{ event: 'paper_profit', name: 'Paper profit per market', aggregation: 'mean' }]);
  assert.deepEqual(plan.rule, brief.rule);
  assert.deepEqual(plan.protect, ['Arena']);
  assert.deepEqual({ flag: plan.flag, environment: plan.environment, create_environment: plan.create_environment, hypothesis: plan.hypothesis },
    { flag: 'trader', environment: 'Arena', create_environment: true, hypothesis: brief.goal });
  // Without a project the plan names none, and the directory's own binding decides.
  assert.equal('project' in planOf(record), false);
});

test('a rejected playbook goes back once with the referee\'s reasons', async () => {
  const a = { ...A, propose: { ...A.propose, playbook: alwaysUp }, repair: { playbook: withMove('A repaired'), hypothesis: 'If A, repaired', why: 'Because.' } };
  const record = await debate(scripted({ A: a, B }), brief, past, 'stub');
  assert.equal(record.proposals.agent_a?.repaired, true);
  assert.equal(record.proposals.agent_a?.playbook?.name, 'A repaired');
  assert.deepEqual(record.proposals.agent_a?.referee, []);
  assert.equal(record.proposals.agent_a?.tokens.in, 200); // both answers are counted
  assert.equal(record.usage.calls, 7);
  assert.equal(record.finalists.agent_a?.from, 'revision');
});

test('an agent whose playbook is rejected twice forfeits, and the other still runs against the coin', async () => {
  const a = { ...A, propose: { ...A.propose, playbook: alwaysUp }, repair: { playbook: unreadable } };
  const record = await debate(scripted({ A: a, B }), brief, past, 'stub');
  assert.equal(record.proposals.agent_a?.playbook, null);
  assert.deepEqual(record.proposals.agent_a?.referee.map(p => p.code), ['signal']);
  assert.equal(record.finalists.agent_a, undefined);
  // With nobody to cross-examine there is no second or third round.
  assert.deepEqual(record.attacks, {});
  assert.deepEqual(record.revisions, {});
  assert.equal(record.usage.calls, 3);
  assert.deepEqual({ from: record.finalists.agent_b?.from, predicts: record.finalists.agent_b?.predicts }, { from: 'proposal', predicts: null });
  assert.equal(record.finalists.agent_b?.playbook.name, 'B first');
  assert.equal(record.agreement, null);

  const plan = planOf(record) as { versions: Record<string, Record<string, unknown>>; split: unknown; control: unknown };
  assert.deepEqual(Object.keys(plan.versions), ['agent_b']);
  assert.deepEqual(plan.split, { agent_b: 33 });
  assert.equal('predicts' in plan.versions.agent_b!, false);
  assert.deepEqual(parseTrader(plan.control), record.coin.trader);
});

test('a playbook that says one side is rejected for what it does, not how it is written', async () => {
  const a = { ...A, propose: { ...A.propose, playbook: alwaysUp }, repair: { playbook: alwaysUp } };
  const record = await debate(scripted({ A: a, B }), brief, past, 'stub');
  assert.deepEqual(record.proposals.agent_a?.referee.map(p => p.code), ['one_sided']);
  assert.equal(record.proposals.agent_a?.seen?.up, 1); // the tape that convicted it stays in the record
  assert.equal(record.finalists.agent_a, undefined);
});

test('a rejected revision falls back to the proposal that passed', async () => {
  const a = { ...A, revise: { ...A.revise, playbook: alwaysUp }, repair: { playbook: unreadable } };
  const record = await debate(scripted({ A: a, B }), brief, past, 'stub');
  assert.equal(record.usage.calls, 7);
  assert.equal(record.revisions.agent_a?.playbook, null);
  assert.deepEqual({ from: record.finalists.agent_a?.from, hypothesis: record.finalists.agent_a?.hypothesis }, { from: 'proposal', hypothesis: 'If A' });
  assert.deepEqual(record.finalists.agent_a?.playbook, read(withMove('A first')));
  assert.equal(record.finalists.agent_b?.from, 'revision');
  // The two finalists now read different signals, so they agree on some markets and not on others.
  assert.equal(record.agreement, Math.round(agreement(read(withMove('A first')), read(againstMove('B revised', 'ret_15m')), past.held) * 1000) / 1000);
  assert.ok(record.agreement! > 0 && record.agreement! < 1);
});
