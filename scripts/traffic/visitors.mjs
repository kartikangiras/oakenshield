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
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
if (!existsSync(join(root, 'apps/dashboard/dist/index.html'))) fail('the dashboard is not built: run `npm run build` first');

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(test, ms, every = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await test()) return true;
  return false;
}

/** A repeatable stream of numbers in [0, 1) for one visitor: mulberry32 over an FNV-1a hash. */
function decisions(key) {
  let h = 2166136261;
  for (const c of key) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const freePort = () => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const scratch = mkdtempSync(join(tmpdir(), 'oak-visitors-'));
const children = [];
async function cleanUp() {
  // The server writes its store as it stops, so the folder goes only once the children have.
  await Promise.all(children.map(c => new Promise(done => {
    if (c.exitCode !== null || c.signalCode !== null) return done();
    c.once('exit', done);
    c.kill();
    setTimeout(done, 3000);
  })));
  try { rmSync(scratch, { recursive: true, force: true }); } catch { /* Chrome may still hold a file */ }
}
process.on('SIGINT', async () => { await cleanUp(); process.exit(130); });

/** The dashboard on a local server, in demo mode, wired to the given Flagsmith environment. */
async function startServer() {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  // A clean environment: nothing from the caller's shell (an API key, live mode) reaches the server.
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    PORT: String(port), HOST: '127.0.0.1',
    OAKENSHIELD_MODE: 'demo', OAKENSHIELD_DEMO_TICK: '0', OAKENSHIELD_DATA: join(scratch, 'store.json'),
    DASHBOARD_FLAGSMITH_ENVIRONMENT: opt.environment,
    ...(opt['api-url'] ? { DASHBOARD_FLAGSMITH_API_URL: opt['api-url'] } : {}),
    ...(opt['events-url'] ? { DASHBOARD_FLAGSMITH_EVENTS_URL: opt['events-url'] } : {}),
  };
  children.push(spawn(process.execPath, [join(root, 'apps/server/src/main.ts')], { env, stdio: ['ignore', 'ignore', 'inherit'] }));
  const up = await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, 30000, 250);
  if (!up) throw new Error('the local server did not start');
  const config = await (await fetch(`${origin}/api/client-config`)).json();
  if (config.experiments?.environmentKey !== opt.environment) throw new Error('the local server is not serving the requested environment');
  return origin;
}

function findChrome() {
  const named = [opt.chrome, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
  const onPath = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
    .flatMap(name => (process.env.PATH ?? '').split(':').map(dir => join(dir, name)));
  return [...named, ...onPath].find(p => p && existsSync(p));
}

/** Headless Chrome, driven over the DevTools protocol so the script needs no packages. */
async function startChrome() {
  const bin = findChrome();
  if (!bin) throw new Error('Chrome was not found: pass --chrome <path> or set CHROME_PATH');
  // On a hosted runner Chrome now and then hangs as it starts, so a silent start is dropped and tried again.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const profile = join(scratch, `chrome-${attempt}`);
    const chrome = spawn(bin, [
      '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-gpu', '--mute-audio', '--window-size=1280,900',
      ...(process.env.CI ? ['--no-sandbox'] : []), // hosted runners do not allow Chrome's sandbox; the only page loaded is our own
      'about:blank',
    ], { stdio: 'ignore' });
    children.push(chrome);
    const portFile = join(profile, 'DevToolsActivePort');
    if (await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'), 30000)) {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      return connect(`ws://127.0.0.1:${port}${path}`);
    }
    chrome.kill('SIGKILL');
    console.error(`visitors: Chrome did not start (attempt ${attempt} of 3)`);
  }
  throw new Error('Chrome did not start');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const waiting = new Map();
    const listeners = new Map();
    let next = 0;
    ws.addEventListener('message', e => {
      const m = JSON.parse(e.data);
      if (m.id === undefined) { if (m.sessionId) listeners.get(m.sessionId)?.(m.method, m.params); return; }
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w?.reject(new Error(`${w.method}: ${m.error.message}`)); else w?.resolve(m.result);
    });
    ws.addEventListener('error', () => reject(new Error('could not connect to Chrome')), { once: true });
    ws.addEventListener('open', () => resolve({
      send: (method, params = {}, sessionId) => new Promise((res, rej) => {
        const id = ++next;
        waiting.set(id, { resolve: res, reject: rej, method });
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      on: (sessionId, fn) => listeners.set(sessionId, fn),
      off: sessionId => listeners.delete(sessionId),
    }), { once: true });
  });
}

const PAGE = 'main.content';
const MAIN_BUTTON = `${PAGE} .btn.primary:not(:disabled)`;
const COPY_BUTTON = `${PAGE} .snippet-head .btn`;

async function visit(cdp, origin, n) {
  const identity = `sim-${seed}-${String(n).padStart(4, '0')}`;
  const v = { identity, screen: 'none', assigned: false, ranCheck: false, copied: false, left: '', delivered: {}, lostBatches: 0 };
  const decide = decisions(identity);
  const pause = () => sleep(400 + Math.random() * 1100);
  const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
  let sessionId;
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId });
    ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    const page = (method, params) => cdp.send(method, params, sessionId);
    const js = async expression => (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    const shows = (selector, ms = 8000) => until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), ms);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);

    // Watch what the dashboard sends, to confirm it arrived. Nothing here changes what is sent.
    const batches = new Map();
    const counting = [];
    let checks = 0;
    cdp.on(sessionId, (method, p) => {
      if (method === 'Network.requestWillBeSent' && p.request.method === 'POST') {
        if (new URL(p.request.url).pathname === '/api/checks') checks++;
        if (p.request.url.includes('/v1/events')) {
          // Chrome leaves the body out of the notification for some requests, so ask for it.
          const body = p.request.postData !== undefined
            ? Promise.resolve(p.request.postData)
            : cdp.send('Network.getRequestPostData', { requestId: p.requestId }, sessionId).then(r => r.postData);
          batches.set(p.requestId, body.then(text => JSON.parse(text).events.map(e => e.event)).catch(() => ['(unread batch)']));
        }
      } else if (method === 'Network.responseReceived') {
        if (p.response.url.includes('/identities/') && p.response.status === 200) v.assigned = true;
        const names = batches.get(p.requestId);
        if (!names) return;
        batches.delete(p.requestId);
        if (p.response.status >= 300) { v.lostBatches++; return; }
        counting.push(names.then(list => { for (const name of list) v.delivered[name] = (v.delivered[name] ?? 0) + 1; }));
      } else if (method === 'Network.loadingFailed' && batches.delete(p.requestId)) v.lostBatches++;
    });

    await page('Page.enable');
    await page('Runtime.enable');
    await page('Network.enable');
    await page('Emulation.setFocusEmulationEnabled', { enabled: true }); // the clipboard needs a focused page
    await cdp.send('Browser.grantPermissions', { origin, browserContextId, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'] });
    // Name the identity so simulated visitors can be told apart in Flagsmith.
    await page('Page.addScriptToEvaluateOnNewDocument', {
      source: `if (location.origin === ${JSON.stringify(origin)}) try { localStorage.setItem('oak-visitor', ${JSON.stringify(identity)}); } catch {}`,
    });

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
      for (let clicks = 0; clicks < 3 && checks === 0; clicks++) {
        if (decide() < GIVE_UP) return 'left before running a check';
        const before = await js('location.hash');
        await click(MAIN_BUTTON);
        await until(async () => checks > 0 || (await js('location.hash')) !== before, 4000);
        await shows(MAIN_BUTTON); // the next screen, or the end of the scan
        await pause();
      }
      if (checks === 0) return 'did not reach a check';
      v.ranCheck = true;

      if (decide() < GIVE_UP) return 'left after the check';
      await click('a.nav-pill[href="#/integrations"]');
      if (!await shows(COPY_BUTTON)) return 'Set up did not load';
      await pause();
      if (decide() < GIVE_UP) return 'left on Set up';
      await click(COPY_BUTTON);
      v.copied = await until(() => js(`/Copied/.test(document.querySelector(${JSON.stringify(COPY_BUTTON)})?.textContent ?? '')`), 2000);
      await pause();
      return 'finished';
    };
    v.left = await behave();

    // Leaving: the window loses focus and is hidden, as when a person switches away, and that is
    // when the dashboard sends what it has queued. Wait for Flagsmith to accept it, then close.
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    await page('Emulation.setFocusEmulationEnabled', { enabled: false });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await until(() => counting.length + v.lostBatches > 0 && batches.size === 0, v.assigned ? 8000 : 1000);
    v.lostBatches += batches.size;
    await Promise.all(counting);
    await page('Page.navigate', { url: 'about:blank' });
  } catch (err) {
    v.left = `error: ${err.message}`;
  } finally {
    if (sessionId) cdp.off(sessionId);
    await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
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
