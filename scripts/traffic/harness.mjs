/*
 * What the traffic scripts share (visitors.mjs: scripted visitors; personas.mjs: AI personas).
 *
 * The built dashboard on a local server, headless Chrome driven over the DevTools protocol so
 * nothing needs installing, and one fresh browser context per visitor. The dashboard asks
 * Flagsmith which version to show and sends the exposure and every event itself, exactly as it
 * does for a person. Nothing here reads a flag or sends an event: it watches what the page sent
 * and whether Flagsmith accepted it.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export async function until(test, ms, every = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) if (await test()) return true;
  return false;
}

/** A repeatable stream of numbers in [0, 1) for one visitor: mulberry32 over an FNV-1a hash. */
export function decisions(key) {
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

/**
 * One run's server, browser and scratch folder. `label` names the script in messages;
 * `environment` is the client-side key of the Flagsmith environment the dashboard is wired to.
 */
export function createHarness({ label, environment, apiUrl, eventsUrl, chrome }) {
  // Simulated visitors never go where real ones are counted: name those environments' keys
  // (comma-separated) in REAL_VISITOR_ENVIRONMENTS and a run aimed at one of them stops here.
  const real = (process.env.REAL_VISITOR_ENVIRONMENTS ?? '').split(',').map(k => k.trim()).filter(Boolean);
  if (real.includes(environment)) throw new Error(`${environment} is an environment real visitors use; simulated visitors are not sent there`);
  const scratch = mkdtempSync(join(tmpdir(), `oak-${label}-`));
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
      DASHBOARD_FLAGSMITH_ENVIRONMENT: environment,
      ...(apiUrl ? { DASHBOARD_FLAGSMITH_API_URL: apiUrl } : {}),
      ...(eventsUrl ? { DASHBOARD_FLAGSMITH_EVENTS_URL: eventsUrl } : {}),
    };
    children.push(spawn(process.execPath, [join(root, 'apps/server/src/main.ts')], { env, stdio: ['ignore', 'ignore', 'inherit'] }));
    const up = await until(async () => { try { return (await fetch(`${origin}/api/health`)).ok; } catch { return false; } }, 30000, 250);
    if (!up) throw new Error('the local server did not start');
    const config = await (await fetch(`${origin}/api/client-config`)).json();
    if (config.experiments?.environmentKey !== environment) throw new Error('the local server is not serving the requested environment');
    return origin;
  }

  function findChrome() {
    const named = [chrome, process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
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
      const proc = spawn(bin, [
        '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--mute-audio', '--window-size=1280,900',
        ...(process.env.CI ? ['--no-sandbox'] : []), // hosted runners do not allow Chrome's sandbox; the only page loaded is our own
        'about:blank',
      ], { stdio: 'ignore' });
      children.push(proc);
      const portFile = join(profile, 'DevToolsActivePort');
      if (await until(() => existsSync(portFile) && readFileSync(portFile, 'utf8').includes('\n'), 30000)) {
        const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
        return connect(`ws://127.0.0.1:${port}${path}`);
      }
      proc.kill('SIGKILL');
      console.error(`${label}: Chrome did not start (attempt ${attempt} of 3)`);
    }
    throw new Error('Chrome did not start');
  }

  /**
   * One visitor: a fresh browser context whose `oak-visitor` id is `identity`. What Flagsmith
   * accepted is written onto `v` as it happens: `assigned`, `delivered` (event name to count) and
   * `lostBatches`. checks() counts the checks the page asked the server to run, busy() the page's
   * calls to the server that have not come back, and with `readFlags`, flags() gives the flags
   * Flagsmith returned for the identity.
   *
   *   const s = await session(cdp, origin, identity, v);
   *   try { await s.open(); ...; await s.leave(); } finally { await s.dispose(); }
   */
  async function session(cdp, origin, identity, v, { readFlags = false } = {}) {
    const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
    let sessionId;
    let targetId;
    const page = (method, params) => cdp.send(method, params, sessionId);
    const js = async expression => (await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
    const shows = (selector, ms = 8000) => until(() => js(`!!document.querySelector(${JSON.stringify(selector)})`), ms);
    const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);

    const batches = new Map();
    const counting = [];
    const calls = new Set();
    let sent = 0;
    let checks = 0;
    let identityRequest;
    let flags;

    async function open() {
      ({ targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId }));
      ({ sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }));

      // Watch what the dashboard sends, to confirm it arrived. Nothing here changes what is sent.
      cdp.on(sessionId, (method, p) => {
        if (method === 'Network.requestWillBeSent') {
          if (p.type !== 'EventSource' && p.request.url.startsWith(`${origin}/api/`)) calls.add(p.requestId);
          if (p.request.method !== 'POST') return;
          if (new URL(p.request.url).pathname === '/api/checks') checks++;
          if (p.request.url.includes('/v1/events')) {
            sent++;
            // Chrome leaves the body out of the notification for some requests, so ask for it.
            const body = p.request.postData !== undefined
              ? Promise.resolve(p.request.postData)
              : cdp.send('Network.getRequestPostData', { requestId: p.requestId }, sessionId).then(r => r.postData);
            batches.set(p.requestId, body.then(text => JSON.parse(text).events.map(e => e.event)).catch(() => ['(unread batch)']));
          }
        } else if (method === 'Network.responseReceived') {
          if (p.response.url.includes('/identities/') && p.response.status === 200) { v.assigned = true; identityRequest = p.requestId; }
          const names = batches.get(p.requestId);
          if (!names) return;
          batches.delete(p.requestId);
          if (p.response.status >= 300) { v.lostBatches++; return; }
          counting.push(names.then(list => { for (const name of list) v.delivered[name] = (v.delivered[name] ?? 0) + 1; }));
        } else if (method === 'Network.loadingFailed') {
          calls.delete(p.requestId);
          if (batches.delete(p.requestId)) v.lostBatches++;
        } else if (method === 'Network.loadingFinished') {
          calls.delete(p.requestId);
          if (readFlags && p.requestId === identityRequest) {
            flags = cdp.send('Network.getResponseBody', { requestId: p.requestId }, sessionId)
              .then(r => JSON.parse(r.base64Encoded ? Buffer.from(r.body, 'base64').toString() : r.body).flags ?? [])
              .catch(() => []);
          }
        }
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
    }

    // Leaving: the window loses focus and is hidden, as when a person switches away, and that is
    // when the dashboard sends what it has queued. Wait for Flagsmith to accept it, then close.
    async function leave() {
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
      const before = sent;
      await page('Emulation.setFocusEmulationEnabled', { enabled: false });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      // On a longer visit the SDK has already sent a batch on its own timer, so an accepted batch
      // is not yet the last one: give the batch sent on hiding a moment to start before waiting.
      await until(() => sent > before, 1000, 25);
      await until(() => counting.length + v.lostBatches > 0 && batches.size === 0, v.assigned ? 8000 : 1000);
      v.lostBatches += batches.size;
      await Promise.all(counting);
      await page('Page.navigate', { url: 'about:blank' });
    }

    async function dispose() {
      if (sessionId) cdp.off(sessionId);
      await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    }

    return { open, leave, dispose, page, js, shows, click, checks: () => checks, busy: () => calls.size, flags: () => flags ?? Promise.resolve(null) };
  }

  return { cleanUp, startServer, startChrome, session };
}
