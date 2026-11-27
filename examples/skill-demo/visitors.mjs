/*
 * Scripted visitors for the demo run of the flagsmith-duel skill.
 *
 * Each visitor reads the flag through the Flagsmith SDK, which records the version it was served,
 * and sends the events at a rate planted per version. The rates are made up: this run rehearses
 * the skill's steps and measures its tokens. It says nothing about the two screens.
 *
 *   node examples/skill-demo/visitors.mjs <client-side key> [visitors per version]
 */
import { createFlagsmithInstance } from '@flagsmith/flagsmith/isomorphic';

const FLAG = 'first_screen_demo';
const PLANTED = {
  control: { check_run: 0.15, setup_snippet_copied: 0.05 },
  short: { check_run: 0.62, setup_snippet_copied: 0.05 },
  steps: { check_run: 0.45, setup_snippet_copied: 0.05 },
};

const [environmentKey, eachArg] = process.argv.slice(2);
const each = Number(eachArg ?? 50);
if (!environmentKey) throw new Error('usage: node visitors.mjs <client-side key> [visitors per version]');

// A fixed seed, so a rerun plants the same pattern.
let seed = 20261128;
const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

const run = `demo-${Date.now().toString(36)}`;
const visitors = {}, sentEvents = {};
let sent = 0;
const short = () => Object.keys(PLANTED).some(arm => (visitors[arm] ?? 0) < each);
while (short() && sent < each * 8) {
  const flagsmith = createFlagsmithInstance();
  await flagsmith.init({ environmentID: environmentKey, identity: `${run}-${++sent}`, enableEvents: true, fetch });
  const served = flagsmith.getExperimentFlag(FLAG);
  const arm = served?.enabled && served.variant && served.variant !== 'control' ? served.variant : 'control';
  visitors[arm] = (visitors[arm] ?? 0) + 1;
  for (const [event, rate] of Object.entries(PLANTED[arm] ?? PLANTED.control)) {
    if (rand() >= rate) continue;
    flagsmith.trackEvent(event);
    (sentEvents[arm] ??= {})[event] = (sentEvents[arm][event] ?? 0) + 1;
  }
  await flagsmith.close(5000);
}
console.log(JSON.stringify({ run, sent, visitors, planted: PLANTED, events_sent: sentEvents }));
