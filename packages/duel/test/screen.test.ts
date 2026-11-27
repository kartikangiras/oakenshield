import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkScreen, parseScreen, scenarioOf } from '../src/screen.ts';
import type { Facts } from '../src/screen.ts';

const facts: Facts = { scenarios: ['rename-event', 'css-only'], numbers: [13, 22] };
const good = {
  version: 1,
  blocks: [
    { type: 'heading', text: 'Will this pull request break your A/B test?' },
    { type: 'pull_request', scenario: 'rename-event', caption: 'A renamed event.' },
    { type: 'run', label: 'Run the check' },
    { type: 'link', label: 'See all 22 samples', to: 'playground' },
  ],
};
const messages = (value: unknown) => checkScreen(value, facts).map(p => p.message).join(' | ');
const withBlocks = (...blocks: unknown[]) => ({ version: 1, blocks });

test('a valid screen passes, as an object and as the text Flagsmith stores', () => {
  assert.deepEqual(checkScreen(good, facts), []);
  assert.deepEqual(parseScreen(JSON.stringify(good)), good);
  assert.equal(scenarioOf(good as never), 'rename-event');
});

test('anything that is not a screen is no screen', () => {
  for (const value of ['control', '', null, 42, '{"version":2,"blocks":[]}', '{not json']) assert.equal(parseScreen(value), null);
});

test('the measured button can be neither dropped nor doubled', () => {
  assert.match(messages(withBlocks({ type: 'heading', text: 'No button here' }, { type: 'text', text: 'Just words.' })), /run/i);
  assert.match(messages(withBlocks({ type: 'run', label: 'Run' }, { type: 'run', label: 'Run again' })), /run/i);
});

test('the button checks the pull request the screen shows', () => {
  const problems = messages(withBlocks({ type: 'pull_request', scenario: 'rename-event' }, { type: 'run', label: 'Run', scenario: 'css-only' }));
  assert.match(problems, /different pull request/);
});

test('claims and numbers the fact sheet does not support are rejected', () => {
  assert.notEqual(messages(withBlocks({ type: 'text', text: 'Trusted by 500 teams.' }, { type: 'run', label: 'Run' })), '');
  assert.notEqual(messages(withBlocks({ type: 'text', text: 'It has 40 rules.' }, { type: 'run', label: 'Run' })), '');
  assert.equal(messages(withBlocks({ type: 'text', text: 'It has 13 rules and 22 samples.' }, { type: 'run', label: 'Run' })), '');
});

test('markup, web addresses and unknown pull requests are rejected', () => {
  assert.notEqual(messages(withBlocks({ type: 'text', text: 'See <b>this</b>.' }, { type: 'run', label: 'Run' })), '');
  assert.notEqual(messages(withBlocks({ type: 'text', text: 'Go to https://example.com now.' }, { type: 'run', label: 'Run' })), '');
  assert.notEqual(messages(withBlocks({ type: 'pull_request', scenario: 'made-up' }, { type: 'run', label: 'Run' })), '');
});

test('length limits hold', () => {
  assert.notEqual(messages(withBlocks({ type: 'text', text: 'x'.repeat(241) }, { type: 'run', label: 'Run' })), '');
  assert.notEqual(messages(withBlocks({ type: 'run', label: 'A label that is far too long for a button to carry' }, { type: 'text', text: 'ok' })), '');
  assert.notEqual(messages(withBlocks({ type: 'run', label: 'Run' })), '');
});
