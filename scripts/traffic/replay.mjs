#!/usr/bin/env node
/*
 * The replay of a persona run: one character per visitor Flagsmith counted, in the order the
 * visits finished. The animation on the landing page and on the Overview plays it back, so every
 * dot it draws is one visitor from the log and none is invented.
 *
 * A character is the version's place in `arms` times two, plus one if that visitor ran a check.
 * Visitors whose exposure never reached Flagsmith are left out, as Flagsmith left them out, so
 * the dots add up to the counts in the verdict.
 *
 * personas.mjs writes replay.json at the end of a run. For a run that is already on disk:
 *   node scripts/traffic/replay.mjs duels/first-screen/traffic
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NO_EXPOSURE = 'assigned, but no exposure was delivered';

/** `visits` in the order they finished; `errors` as the run's summary lists them. */
export function replayOf(visits, errors = []) {
  const unseen = new Set(errors.filter(e => e.problem === NO_EXPOSURE).map(e => e.visitor));
  const counted = visits.filter(v => v.arm !== 'unassigned' && !unseen.has(v.visitor));
  const arms = [...new Set(counted.map(v => v.arm))].sort((a, b) => (b === 'control') - (a === 'control') || a.localeCompare(b));
  return {
    simulated: true,
    kind: 'AI personas, not people',
    order: 'the order the visits finished',
    event: 'check_run',
    arms,
    visitors: counted.length,
    leftOut: visits.length - counted.length,
    visits: counted.map(v => (arms.indexOf(v.arm) * 2 + (v.checkRun ? 1 : 0)).toString(36)).join(''),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('replay: give the folder a persona run wrote, for example duels/first-screen/traffic');
    process.exit(2);
  }
  const lines = readFileSync(join(dir, 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const { errors } = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  const replay = replayOf(lines.filter(line => line.type === 'visitor'), errors);
  writeFileSync(join(dir, 'replay.json'), `${JSON.stringify(replay, null, 2)}\n`);
  console.log(`replay: ${replay.visitors} visitors (${replay.leftOut} left out) in ${join(dir, 'replay.json')}`);
}
