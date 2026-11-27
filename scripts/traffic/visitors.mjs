#!/usr/bin/env node
/*
 * Simulated visitors for the dashboard's own A/B test (the demo_start flag).
 *
 * This is scripted traffic, not people. It exists so the experiment can be run end to end, and its
 * numbers must always be reported as simulated. Never point it at an environment real visitors
 * use: give it the client-side key of an environment kept for simulation.
 *
 * What is real: each visitor is a fresh headless Chrome profile that opens the built dashboard on
 * a local server. The dashboard asks Flagsmith which version to show, and the dashboard sends the
 * exposure and every event, exactly as it does for a person. This script never reads the flag and
 * never sends an event itself; it clicks, hides the window to leave, and counts what was accepted.
 *
 * What is modelled: when a visitor clicks and when they leave. One rule for every visitor,
 * whichever version they were given:
 *   1. BOUNCE of them leave from the first screen.
 *   2. The rest press the main button of whatever screen they are on until a check has run.
 *   3. Then they open Set up from the navigation and copy the snippet.
 *   Before every click, GIVE_UP of the visitors still there leave instead.
 * So a version that needs one click fewer keeps more visitors, and that is the only source of a
 * difference between the versions. The model says nothing about what persuades a real person.
 *
 * With --aa the visitor ignores the first screen and opens the Playground from the address bar, so
 * both versions get identical behaviour. That is the dry run: any difference it shows is noise.
 *
 * Usage:
 *   npm run build
 *   node scripts/traffic/visitors.mjs --environment <client-side key> [--visitors 16] [--aa]
 *
 * Options: --concurrency 3, --seed <text> (names the identities, sim-<seed>-<n>, and fixes every
 * decision), --api-url and --events-url (self-hosted Flagsmith, or the local stand-in in
 * scripts/e2e/flagsmith-standin.mjs), --chrome <path> or CHROME_PATH, and --self-test, which fails
 * on a single error or lost batch: run it against the stand-in before sending anything real.
 */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createHarness, decisions, root, sleep, until } from './harness.mjs';

const BOUNCE = 0.4;
const GIVE_UP = 0.3;

const { values: opt } = parseArgs({
  options: {
    environment: { type: 'string' },
    visitors: { type: 'string', default: '16' },
    aa: { type: 'boolean', default: false },
    'self-test': { type: 'boolean', default: false },
    concurrency: { type: 'string', default: '3' },
    seed: { type: 'string' },
    'api-url': { type: 'string' },
    'events-url': { type: 'string' },
    chrome: { type: 'string' },
  },
});
const fail = msg => { console.error(`visitors: ${msg}`); process.exit(2); };
if (!opt.environment) fail('--environment <client-side key> is required');
const total = Number(opt.visitors);
const concurrency = Math.max(1, Number(opt.concurrency));
if (!Number.isInteger(total) || total < 1) fail('--visitors must be a whole number');
const seed = opt.seed ?? process.env.GITHUB_RUN_ID ?? Date.now().toString(36);

if (!existsSync(join(root, 'apps/dashboard/dist/index.html'))) fail('the dashboard is not built: run `npm run build` first');

// The local server, headless Chrome and one browser context per visitor: scripts/traffic/harness.mjs.
const { cleanUp, startServer, startChrome, session } = createHarness({
  label: 'visitors', environment: opt.environment, apiUrl: opt['api-url'], eventsUrl: opt['events-url'], chrome: opt.chrome,
});

const PAGE = 'main.content';
// A page's main button is in its heading, which sits in the slot above the page, or in the page.
const MAIN_BUTTON = `.page-slot .btn.primary:not(:disabled), ${PAGE} .btn.primary:not(:disabled)`;
const COPY_BUTTON = `${PAGE} .snippet-head .btn`;

async function visit(cdp, origin, n) {
  const identity = `sim-${seed}-${String(n).padStart(4, '0')}`;
  const v = { identity, screen: 'none', assigned: false, ranCheck: false, copied: false, left: '', delivered: {}, lostBatches: 0 };
  const decide = decisions(identity);
  const pause = () => sleep(400 + Math.random() * 1100);
  const s = await session(cdp, origin, identity, v);
  const { page, js, shows, click, checks } = s;
  try {
    await s.open();

    const behave = async () => {
      await page('Page.navigate', { url: `${origin}/app/` });
      if (!await shows(MAIN_BUTTON, 15000)) return 'the first screen did not load';
      await pause();
      v.screen = await js(`document.querySelector(${JSON.stringify(`${PAGE} .guided`)}) ? 'guided' : 'overview'`);
      if (decide() < BOUNCE) return 'bounced';

      if (opt.aa) {
        if (decide() < GIVE_UP) return 'left before opening the Playground';
        await js(`location.hash = '#/playground'`);
        await shows(MAIN_BUTTON);
        await pause();
      }
      for (let clicks = 0; clicks < 3 && checks() === 0; clicks++) {
        if (decide() < GIVE_UP) return 'left before running a check';
        const before = await js('location.hash');
        await click(MAIN_BUTTON);
        await until(async () => checks() > 0 || (await js('location.hash')) !== before, 4000);
        await shows(MAIN_BUTTON); // the next screen, or the end of the scan
        await pause();
      }
      if (checks() === 0) return 'did not reach a check';
      v.ranCheck = true;

      if (decide() < GIVE_UP) return 'left after the check';
      await click('a.nav-link[href="#/integrations"]');
      if (!await shows(COPY_BUTTON)) return 'Set up did not load';
      await pause();
      if (decide() < GIVE_UP) return 'left on Set up';
      await click(COPY_BUTTON);
      v.copied = await until(() => js(`/Copied/.test(document.querySelector(${JSON.stringify(COPY_BUTTON)})?.textContent ?? '')`), 2000);
      await pause();
      return 'finished';
    };
    v.left = await behave();
    await s.leave(); // hides the window, which is when the dashboard sends what it has queued
  } catch (err) {
    v.left = `error: ${err.message}`;
  } finally {
    await s.dispose();
  }
  return v;
}

function summarise(visits) {
  const rows = {};
  const delivered = {};
  for (const v of visits) {
    const r = (rows[v.screen] ??= { visitors: 0, ranCheck: 0, copied: 0 });
    r.visitors++;
    if (v.ranCheck) r.ranCheck++;
    if (v.copied) r.copied++;
    for (const [name, count] of Object.entries(v.delivered)) delivered[name] = (delivered[name] ?? 0) + count;
  }
  return {
    simulated: true,
    mode: opt.aa ? 'aa' : 'ab',
    environment: opt.environment,
    seed,
    model: { bounce: BOUNCE, giveUpPerClick: GIVE_UP },
    visitors: visits.length,
    assigned: visits.filter(v => v.assigned).length,
    firstScreen: rows,
    eventsDelivered: delivered,
    lostBatches: visits.reduce((n, v) => n + v.lostBatches, 0),
    left: visits.reduce((all, v) => ({ ...all, [v.left]: (all[v.left] ?? 0) + 1 }), {}),
    errors: visits.flatMap(v => [
      ...(v.left.startsWith('error') || v.left.includes('did not') ? [`${v.identity}: ${v.left}`] : []),
      ...(v.assigned && !v.delivered.$flag_exposure ? [`${v.identity}: Flagsmith did not confirm the exposure`] : []),
    ]),
  };
}

function markdown(s) {
  const pct = (a, b) => (b ? `${a} (${Math.round((100 * a) / b)}%)` : '0');
  const lines = [
    `### Simulated traffic: ${s.visitors} scripted visitors`,
    '',
    `These are not people. Mode: ${s.mode === 'aa' ? 'A/A dry run (identical behaviour in both versions)' : 'scripted run'}. Identities: \`sim-${s.seed}-…\`. Environment: \`${s.environment}\`.`,
    '',
    '| First screen | Visitors | Ran a check | Copied a snippet |',
    '|---|---|---|---|',
    ...Object.entries(s.firstScreen).map(([screen, r]) => `| ${screen} | ${r.visitors} | ${pct(r.ranCheck, r.visitors)} | ${pct(r.copied, r.visitors)} |`),
    '',
    `Events Flagsmith accepted: ${Object.entries(s.eventsDelivered).map(([k, n]) => `\`${k}\` × ${n}`).join(', ') || 'none'}. Batches lost: ${s.lostBatches}. Visitors with an error: ${s.errors.length}.`,
  ];
  return lines.join('\n');
}

let code = 0;
try {
  const origin = await startServer();
  const cdp = await startChrome();
  const queue = Array.from({ length: total }, (_, i) => i + 1);
  const visits = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, async () => {
    while (queue.length) visits.push(await visit(cdp, origin, queue.shift()));
  }));
  const summary = summarise(visits);
  console.log(JSON.stringify(summary, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY && !opt['self-test']) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown(summary)}\n`);
  // A run where a fifth of the visitors broke is not a run to count.
  if (summary.errors.length > (opt['self-test'] ? 0 : total / 5) || (opt['self-test'] && summary.lostBatches > 0)) code = 1;
} catch (err) {
  console.error(`visitors: ${err.message}`);
  code = 1;
} finally {
  await cleanUp();
}
process.exit(code);
