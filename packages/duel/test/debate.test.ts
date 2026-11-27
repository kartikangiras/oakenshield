import { test } from 'node:test';
import assert from 'node:assert/strict';
import { debate, planOf } from '../src/debate.ts';
import type { Brief } from '../src/agents.ts';
import { jsonIn } from '../src/llm.ts';
import type { Ask } from '../src/llm.ts';

const brief: Brief = {
  name: 'Test duel', flag: 'first_screen', environment: 'Duel', goal: 'More visitors run a check.',
  event: { key: 'check_run', name: 'Ran a check' }, guardrails: [{ key: 'setup_snippet_copied', name: 'Copied the snippet' }],
  product: 'A guard.', today: 'A dashboard.', visitors: 'Engineers.',
  facts: { statements: ['It has 13 rules.'], numbers: [13], scenarios: ['rename-event'], scenarioTitles: { 'rename-event': 'Rename the event' } },
  rule: { min_per_arm: 100, win_above: 0.95, harm_below: 0.05 }, split: { agent_a: 33, agent_b: 33 },
};
const screen = (heading: string) => ({ version: 1, blocks: [{ type: 'heading', text: heading }, { type: 'run', label: 'Run the check' }] });
const noButton = { version: 1, blocks: [{ type: 'heading', text: 'No button' }, { type: 'text', text: 'Words only.' }] };
const reply = (value: unknown) => ({ text: '```json\n' + JSON.stringify(value) + '\n```', ms: 10, tokens: { in: 100, out: 20 }, cost: 0.001 });
const who = (system: string) => (system.includes('You are Agent A') ? 'A' : 'B');

/** A model that plays both agents from a script: `answers[agent][kind of question]`. */
function scripted(answers: Record<string, Record<string, unknown>>): Ask {
  return async (system, prompt) => {
    const kind = prompt.includes('The referee rejected') ? 'repair' : prompt.includes('Cross-examine') ? 'attack' : prompt.includes('You may revise') ? 'revise' : 'propose';
    return reply(answers[who(system)]![kind]);
  };
}
const fair = (name: string) => ({
  propose: { screen: screen(`${name} first`), hypothesis: `If ${name}`, why: 'Because.' },
  attack: { attacks: ['Too long.', 'Too vague.'], concedes: 'It is clear.' },
  revise: { screen: screen(`${name} revised`), changed: 'The heading.', hypothesis: `If ${name}, revised`, predicts: { control: 0.1, agent_a: 0.3, agent_b: 0.2 } },
});

test('a model answer wrapped in a code fence still yields its JSON', () => {
  assert.deepEqual(jsonIn('Here you go:\n```json\n{"a":{"b":1}}\n```\nHope that helps {really}.'), { a: { b: 1 } });
  assert.equal(jsonIn('no json here'), null);
});

test('both agents propose, attack, revise and predict; the revisions enter the experiment', async () => {
  const record = await debate(scripted({ A: fair('A'), B: fair('B') }), brief, 'stub');
  assert.equal(record.usage.calls, 6);
  assert.equal(record.finalists.agent_a?.from, 'revision');
  assert.equal(record.finalists.agent_b?.screen.blocks[0]?.type, 'heading');
  assert.deepEqual(record.finalists.agent_a?.predicts, { control: 0.1, agent_a: 0.3, agent_b: 0.2 });
  assert.equal(record.attacks.agent_a?.attacks.length, 2);

  const plan = planOf(record, 7) as { versions: Record<string, { value: unknown }>; protect: string[]; split: unknown; project: number };
  assert.deepEqual(Object.keys(plan.versions), ['agent_a', 'agent_b']);
  assert.deepEqual(plan.versions.agent_a!.value, screen('A revised'));
  assert.deepEqual(plan.protect, ['Duel']);
  assert.deepEqual(plan.split, { agent_a: 33, agent_b: 33 });
});

test('a rejected screen goes back once with the referee\'s reasons', async () => {
  const a = { ...fair('A'), propose: { screen: noButton, hypothesis: 'If A', why: '' }, repair: { screen: screen('A repaired') } };
  const record = await debate(scripted({ A: a, B: fair('B') }), brief, 'stub');
  assert.equal(record.proposals.agent_a?.repaired, true);
  assert.equal(record.usage.calls, 7);
  assert.ok(record.finalists.agent_a);
});

test('an agent whose screen is rejected twice forfeits, and the other still runs against control', async () => {
  const a = { ...fair('A'), propose: { screen: noButton, hypothesis: 'If A', why: '' }, repair: { screen: noButton } };
  const record = await debate(scripted({ A: a, B: fair('B') }), brief, 'stub');
  assert.equal(record.finalists.agent_a, undefined);
  assert.equal(record.finalists.agent_b?.from, 'proposal');
  assert.ok((record.proposals.agent_a?.referee.length ?? 0) >= 2);
  const plan = planOf(record) as { versions: Record<string, unknown> };
  assert.deepEqual(Object.keys(plan.versions), ['agent_b']);
});

test('a rejected revision falls back to the proposal that passed', async () => {
  const a = { ...fair('A'), revise: { ...fair('A').revise, screen: noButton }, repair: { screen: noButton } };
  const record = await debate(scripted({ A: a, B: fair('B') }), brief, 'stub');
  assert.equal(record.finalists.agent_a?.from, 'proposal');
  assert.deepEqual(record.finalists.agent_a?.screen, screen('A first'));
  assert.deepEqual(record.finalists.agent_a?.predicts, { control: 0.1, agent_a: 0.3, agent_b: 0.2 });
});
