import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfigText } from '../src/config.ts';
import { runCheck } from '../src/engine.ts';
import { DiffOnlyRepoView, MemoryRepoView } from '../src/repo.ts';
import { renderText } from '../src/report.ts';
import { isConfigFile, scanLine } from '../src/scanner.ts';
import type { Snapshot } from '../src/types.ts';

// A checkout experiment in a codebase that keeps its flag key and event names in a plan file.
// No call names them: the code passes whatever the plan says to the SDK.
const checkout: Snapshot = {
  fetchedAt: '2026-11-28T11:00:00.000Z',
  source: 'file',
  environmentKey: 'test',
  experiments: [{
    id: 901,
    name: 'One page checkout',
    environmentKey: 'test',
    flagKey: 'checkout_flow',
    controlValue: 'steps',
    variationKeys: ['one_page'],
    metricEvents: ['order_paid', 'order_refunded'],
    metrics: [
      { event: 'order_paid', expectedDirection: 'increase' },
      { event: 'order_refunded', expectedDirection: 'not_increase' },
    ],
    status: 'running',
  }],
};

const PLAN = [
  '{',                                                 // 1
  '  "name": "One page checkout",',                    // 2
  '  "flag": "checkout_flow",',                        // 3
  '  "goal": { "event": "order_paid" },',              // 4
  '  "guardrails": [{ "event": "order_refunded" }]',   // 5
  '}',                                                 // 6
  '',
].join('\n');

const CODE = [
  "import plan from '../experiments/checkout.json' with { type: 'json' };",                              // 1
  'export async function arm(client, user) {',                                                           // 2
  '  const flag = await client.getExperimentFlag(plan.flag, user);',                                     // 3
  '  return flag.variant;',                                                                              // 4
  '}',                                                                                                   // 5
  'export const paid = (client, user) => client.trackEvent(plan.goal.event, { identifier: user });',     // 6
  '',
].join('\n');

const base = { 'experiments/checkout.json': PLAN, 'src/experiments.ts': CODE };
const withPlan = (plan: string) => ({ ...base, 'experiments/checkout.json': plan });
const check = (head: Record<string, string>, from: Record<string, string> = base) => runCheck({ repo: new MemoryRepoView(from, head), snapshot: checkout });
const rulesOf = (r: { findings: Array<{ rule: string }> }) => r.findings.map(f => f.rule);

describe('events declared in config', () => {
  it('blocks a renamed event in the file that declares it', () => {
    const report = check(withPlan(PLAN.replace('"order_paid"', '"orderPaid"')));
    assert.deepEqual(rulesOf(report), ['EG001']);
    assert.equal(report.verdict, 'block');
    const f = report.findings[0];
    assert.equal(`${f.file}:${f.line}`, 'experiments/checkout.json:4');
    assert.match(f.consequence, /Nothing in the codebase sends 'order_paid' any more/);
    assert.match(f.hint!, /Renamed to 'orderPaid'/);
    assert.equal(f.suggestion?.replacement, '  "goal": { "event": "order_paid" },');
  });

  it('says a declaration went, not a call site, when another file still names the event', () => {
    const copy = { ...base, 'experiments/checkout.lock.json': PLAN };
    const report = check({ ...copy, 'experiments/checkout.json': PLAN.replace('"order_paid"', '"orderPaid"') }, copy);
    assert.deepEqual(rulesOf(report), ['EG001']);
    assert.match(report.findings[0].consequence, /This file no longer declares 'order_paid'/);
    assert.match(report.findings[0].consequence, /experiments\/checkout\.lock\.json:4 still names 'order_paid'/);
    assert.doesNotMatch(report.findings[0].consequence, /call site/);
  });

  it('blocks a guardrail event dropped from the plan', () => {
    const report = check(withPlan(PLAN.replace(',\n  "guardrails": [{ "event": "order_refunded" }]', '')));
    assert.deepEqual(rulesOf(report), ['EG001']);
    assert.match(report.findings[0].consequence, /It is a guardrail for "One page checkout"/);
  });
});

describe('a flag key declared in config', () => {
  it('blocks a renamed flag key', () => {
    const report = check(withPlan(PLAN.replace('"checkout_flow"', '"checkout_flow_next"')));
    assert.deepEqual(rulesOf(report), ['EG002']);
    assert.equal(report.verdict, 'block');
    const f = report.findings[0];
    assert.equal(`${f.file}:${f.line}:${f.side}`, 'experiments/checkout.json:3:removed');
    assert.equal(f.evidence, '- "flag": "checkout_flow",');
    assert.match(f.consequence, /Nothing declares 'checkout_flow' any more/);
    assert.match(f.consequence, /No new users enter "One page checkout"/);
  });

  it('names the file that still holds the key', () => {
    const copy = { ...base, 'experiments/checkout.lock.json': PLAN };
    const report = check({ ...copy, 'experiments/checkout.json': PLAN.replace('"checkout_flow"', '"checkout_flow_next"') }, copy);
    assert.deepEqual(rulesOf(report), ['EG002']);
    assert.match(report.findings[0].consequence, /experiments\/checkout\.lock\.json:3 still names 'checkout_flow'/);
  });

  it('does not count a declaration that moved to another file', () => {
    const moved = { ...withPlan(PLAN.replace('  "flag": "checkout_flow",\n', '')), 'experiments/flags.json': '{\n  "checkout": "checkout_flow"\n}\n' };
    assert.deepEqual(check(moved).findings, []);
  });

  it('blocks the last call that reads a flag through a variable', () => {
    const head = { ...base, 'src/experiments.ts': CODE.replace('await client.getExperimentFlag(plan.flag, user)', '(await client.getIdentityFlags(user)).getFlag(plan.flag)') };
    const report = check(head);
    assert.deepEqual(rulesOf(report), ['EG002']);
    const f = report.findings[0];
    assert.equal(`${f.file}:${f.line}`, 'src/experiments.ts:3');
    assert.match(f.consequence, /No getExperimentFlag call takes its flag key from a variable any more/);
    assert.match(f.consequence, /declared in experiments\/checkout\.json:3/);
  });

  it('stays quiet while another call still reads a flag that way', () => {
    const two = { ...base, 'src/preview.ts': 'export const preview = (client, key, user) => client.getExperimentFlag(key, user);\n' };
    const head = { ...two, 'src/experiments.ts': CODE.replace('await client.getExperimentFlag(plan.flag, user)', 'null') };
    assert.deepEqual(check(head, two).findings, []);
  });

  it('leaves a config line alone when the code names the flag itself', () => {
    const named = { ...base, 'src/experiments.ts': CODE.replace('plan.flag', "'checkout_flow'") };
    const head = { ...named, 'experiments/checkout.json': PLAN.replace('  "flag": "checkout_flow",\n', '') };
    const report = check(head, named);
    assert.deepEqual(report.findings, []);
  });

  it('leaves a config line alone when no call reads a flag through a variable', () => {
    const data = { 'fixtures/flags.json': '{\n  "flags": ["checkout_flow", "dark_mode"]\n}\n', 'src/app.ts': 'export {};\n' };
    const report = check({ ...data, 'fixtures/flags.json': '{\n  "flags": ["dark_mode"]\n}\n' }, data);
    assert.deepEqual(report.findings, []);
    assert.equal(report.notes, undefined);
  });

  it('counts a removed declaration in a pasted diff, which has no code to check', () => {
    const diff = 'diff --git a/experiments/checkout.json b/experiments/checkout.json\n--- a/experiments/checkout.json\n+++ b/experiments/checkout.json\n@@ -3 +3 @@\n-  "flag": "checkout_flow",\n+  "flag": "checkout_next",\n';
    assert.deepEqual(rulesOf(runCheck({ repo: new DiffOnlyRepoView(diff), snapshot: checkout })), ['EG002']);
  });
});

describe('config formats', () => {
  const YAML = [
    'name: One page checkout',        // 1
    'flag: checkout_flow',            // 2
    'goal: order_paid   # counted once per visitor', // 3
    'guardrails: [order_refunded]',   // 4
    '',
  ].join('\n');
  const yaml = { 'experiments/checkout.yml': YAML, 'src/experiments.ts': CODE };

  it('knows a config file by its name', () => {
    for (const p of ['plan.json', 'a/b/plan.yaml', 'plan.yml', 'settings.toml', 'app.properties', '.env.example', 'deploy/.env']) assert.equal(isConfigFile(p), true, p);
    for (const p of ['src/plan.ts', 'README.md', 'env.ts', 'notes.txt']) assert.equal(isConfigFile(p), false, p);
  });

  it('reads values written without quotes', () => {
    const literals = (file: string, text: string) => [...scanLine(file, 1, text, 'head').literals];
    assert.deepEqual(literals('a.yml', 'flag: checkout_flow'), ['flag', 'checkout_flow']);
    assert.deepEqual(literals('a.yml', '  - order_paid'), ['order_paid']);
    assert.deepEqual(literals('a.yml', 'events: [order_paid, order_refunded]'), ['events', 'order_paid', 'order_refunded']);
    assert.deepEqual(literals('.env.example', 'GOAL_EVENT=order_paid'), ['GOAL_EVENT', 'order_paid']);
    assert.deepEqual(literals('a.yml', 'name: One page checkout'), ['name']);
    assert.deepEqual(literals('a.json', '  "note": "flag: checkout_flow, then pay"'), ['note', 'flag: checkout_flow, then pay']);
    assert.deepEqual(literals('src/a.ts', 'const flag: checkout_flow = x;'), []);
  });

  it('blocks renames in a YAML plan', () => {
    const head = { ...yaml, 'experiments/checkout.yml': YAML.replace('flag: checkout_flow', 'flag: checkout_next').replace('goal: order_paid', 'goal: orderPaid') };
    const report = check(head, yaml);
    assert.deepEqual(rulesOf(report), ['EG001', 'EG002']);
    assert.match(report.findings[0].hint!, /Renamed to 'orderPaid'/);
    assert.equal(`${report.findings[1].file}:${report.findings[1].line}`, 'experiments/checkout.yml:2');
  });
});

describe('what Guard says it watches', () => {
  it('passes a change that keeps every key and names the declarations', () => {
    const report = check(withPlan(PLAN.replace('One page checkout', 'Checkout on one page')));
    assert.deepEqual(report.findings, []);
    assert.equal(report.verdict, 'pass');
    assert.equal(report.notes?.length, 1);
    assert.match(report.notes![0], /Guard watches where `checkout_flow` \(experiments\/checkout\.json:3\), `order_paid` \(experiments\/checkout\.json:4\), `order_refunded` \(experiments\/checkout\.json:5\) are declared/);
    assert.match(renderText(report), /note {2}Guard watches where checkout_flow/);
  });

  it('adds no note for keys that only sit in data files', () => {
    const data = { 'fixtures/events.json': '["order_paid", "order_refunded", "checkout_flow"]\n', 'src/app.ts': 'export {};\n' };
    assert.equal(check(data, data).notes, undefined);
  });
});

describe('code that gives a flag value its meaning', () => {
  // The variation's value is data. The code that reads it sits far from the flag call and never compares a variation key.
  const RULES = 'export const layout = (value: { steps: number }) => (value.steps === 1 ? "one" : "many");\n';
  const from = { ...base, 'src/checkout/layout.ts': RULES };
  const head = { ...from, 'src/checkout/layout.ts': RULES.replace('=== 1', '<= 2') };
  const config = (extra = '') => parseConfigText(`treatment_paths:\n  checkout_flow: [src/checkout/**]\n${extra}`).config;

  it('warns when a file listed under treatment_paths changes mid-run', () => {
    const report = runCheck({ repo: new MemoryRepoView(from, head), snapshot: checkout, config: config() });
    assert.deepEqual(rulesOf(report), ['EG006']);
    assert.equal(report.verdict, 'warn');
    assert.equal(`${report.findings[0].file}:${report.findings[0].line}`, 'src/checkout/layout.ts:1');
    assert.match(report.findings[0].consequence, /listed under treatment_paths for 'checkout_flow'/);
  });

  it('can be raised to a block, and says nothing without the list', () => {
    assert.equal(runCheck({ repo: new MemoryRepoView(from, head), snapshot: checkout, config: config('rules:\n  EG006: block\n') }).verdict, 'block');
    assert.deepEqual(check(head, from).findings, []);
  });

  it('ignores files outside the list and flags that are not running', () => {
    const other = { ...from, 'src/experiments.ts': `${CODE}// reviewed\n` };
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(from, other), snapshot: checkout, config: config() }).findings, []);
    const ended = { ...checkout, experiments: checkout.experiments.map(e => ({ ...e, status: 'ended' as const })) };
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(from, head), snapshot: ended, config: config() }).findings, []);
  });

  it('rejects a value that is not a list of globs', () => {
    assert.throws(() => parseConfigText('treatment_paths:\n  checkout_flow: src\n'), /treatment_paths\.checkout_flow must be a list/);
  });
});
