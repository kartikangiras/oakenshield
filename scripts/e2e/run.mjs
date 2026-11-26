#!/usr/bin/env node
// End-to-end run of every surface against real processes:
//   a Flagsmith stand-in (Flagsmith's Admin API shapes and signed webhooks, see flagsmith-standin.mjs),
//   a fake GitHub API, the Oakenshield server in live mode, the CLI, the GitHub Action path and the
//   MCP server over stdio. It builds a throwaway git repo from examples/demo-app.
//
//   npm run e2e            (Node 22.18+, git)
//
// Nothing here talks to the internet: Flagsmith and GitHub are local stand-ins.
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import readline from 'node:readline';

const root = resolve(import.meta.dirname, '../..');
const bin = join(root, 'packages/guard/bin/experiment-guard.js');
const work = mkdtempSync(join(tmpdir(), 'oak-e2e-'));
const repo = join(work, 'repo');
const port = (n) => Number(process.env.E2E_PORT_BASE ?? 19100) + n;
const FS = `http://127.0.0.1:${port(0)}`, GH = `http://127.0.0.1:${port(1)}`, OAK = `http://127.0.0.1:${port(2)}`;
const WEBHOOK = `${OAK}/api/webhooks/flagsmith`, SECRET = 'whsec-e2e';
const flagsmithEnv = { FLAGSMITH_API_URL: FS, FLAGSMITH_API_KEY: 'e2e-org-key', GUARD_FLAGSMITH_ENVIRONMENT: 'demo_prod' };

let failures = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? `  (${extra})` : ''}`); if (!cond) failures++; };
const section = (t) => console.log(`\n${t}`);
const children = [];
const start = (script, env) => new Promise((res, rej) => {
  const c = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(c);
  let log = '';
  c.stdout.on('data', d => { log += d; if (/ on http/.test(log)) res(c); });
  c.stderr.on('data', d => { log += d; });
  c.on('exit', code => rej(new Error(`${script} exited (${code}):\n${log}`)));
  c.on('error', rej);
});
const json = async (url, init) => { const r = await fetch(url, init); return { status: r.status, body: await r.json().catch(() => null) }; };
const post = (url, body, headers = {}) => json(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const guard = (args, env = {}, cwd = repo) => {
  try { return { code: 0, out: execFileSync(process.execPath, [bin, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }; }
};
const ghState = async () => (await json(`${GH}/__admin/state`, { method: 'POST' })).body;

try {
  // ---------------------------------------------------------------- repo with four pull requests
  cpSync(join(root, 'examples/demo-app'), repo, { recursive: true });
  writeFileSync(join(repo, 'app/components/DocsCta.tsx'), `import flagsmith from '@flagsmith/flagsmith';
import { useExperiment } from '@flagsmith/flagsmith/react';

export function DocsCta() {
  const flag = useExperiment('docs_cta');
  const sticky = flag?.enabled && flag.variant === 'sticky';
  return (
    <a className={sticky ? 'cta cta-sticky' : 'cta'} href="/signup"
      onClick={() => flagsmith.trackEvent('signup_started')}>
      Find your first issue
    </a>
  );
}
`);
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 'e2e@oakenshield.dev'); git('config', 'user.name', 'E2E');
  git('add', '-A'); git('commit', '-qm', 'FirstPR app');
  const branch = (name, file, from, to, msg) => {
    git('checkout', '-qb', name, 'main');
    const p = join(repo, file); const src = readFileSync(p, 'utf8');
    if (from !== null && !src.includes(from)) throw new Error(`${file} does not contain ${from}`);
    writeFileSync(p, from === null ? src + to : src.replace(from, to)); git('commit', '-qam', msg); git('checkout', '-q', 'main');
  };
  branch('pr-7', 'app/components/DocsCta.tsx', "trackEvent('signup_started')", "trackEvent('signupStarted')", 'chore: camelCase the sign-up event');
  branch('pr-8', 'app/Landing.tsx', "flag.variant === 'github_first'", "flag.variant === 'github-first'", 'refactor: kebab-case variant');
  branch('pr-9', 'app/providers.tsx', "visitor_type: isReturningVisitor() ? 'returning' : 'new', ", '', 'chore: trim identify traits');
  branch('pr-10', 'app/styles.css', null, '\n.cta { margin: 8px; }\n', 'style: spacing');

  // ---------------------------------------------------------------- stand-ins and server
  await start(join(root, 'scripts/e2e/flagsmith-standin.mjs'), { PORT: String(port(0)) });
  await start(join(root, 'scripts/e2e/fake-github.mjs'), { PORT: String(port(1)), GH_TOKEN: 'ghs_e2e' });
  await start(join(root, 'apps/server/src/main.ts'), {
    PORT: String(port(2)), OAKENSHIELD_MODE: 'live', OAKENSHIELD_DATA: join(work, 'oak.json'), OAKENSHIELD_REPO_PATH: repo,
    OAKENSHIELD_TOKEN: 'ingest-secret', OAKENSHIELD_WEBHOOK_SECRET: SECRET, GITHUB_TOKEN: 'ghs_e2e', GITHUB_API_URL: GH, ...flagsmithEnv,
    // The SDK-style URL Flagsmith's self-hosting docs give; the CLI runs above use the bare host.
    FLAGSMITH_API_URL: `${FS}/api/v1/`,
  });

  section("Guarding this repo's own A/B test (docs/experiment.md)");
  {
    const own = join(work, 'own');
    mkdirSync(join(own, 'apps'), { recursive: true });
    cpSync(join(root, 'apps/dashboard/src'), join(own, 'apps/dashboard/src'), { recursive: true });
    cpSync(join(root, 'apps/dashboard/package.json'), join(own, 'apps/dashboard/package.json'));
    cpSync(join(root, '.experiment-guard.yml'), join(own, '.experiment-guard.yml'));
    // demo_start is read live from the stand-in's Admin API, as the workflow does from Flagsmith.
    const ownEnv = { ...flagsmithEnv, GUARD_FLAGSMITH_ENVIRONMENT: 'oak_demo' };
    const g = (...a) => execFileSync('git', a, { cwd: own, encoding: 'utf8' }).trim();
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 'e2e@oakenshield.dev'); g('config', 'user.name', 'E2E'); g('add', '-A'); g('commit', '-qm', 'base');
    const cases = [
      ['rename the conversion event', 'apps/dashboard/src/pages/Playground.tsx', "trackEvent('check_run');", "trackEvent('checkRun');", 1, 'EG001'],
      ['rename the guardrail event', 'apps/dashboard/src/pages/Integrations.tsx', "trackEvent('setup_snippet_copied')", "trackEvent('snippet_copied')", 1, 'EG001'],
      ['turn events off', 'apps/dashboard/src/lib/experiments.ts', '        enableEvents: true,\n', '', 1, 'EG003'],
      ['rename the variation', 'apps/dashboard/src/App.tsx', "start.variant === 'try_it'", "start.variant === 'tryIt'", 1, 'EG005'],
      ['rename the flag', 'apps/dashboard/src/App.tsx', "useExperiment('demo_start'", "useExperiment('demoStart'", 1, 'EG002'],
      ['downgrade the SDK', 'apps/dashboard/package.json', '"@flagsmith/flagsmith": "^12.4.0"', '"@flagsmith/flagsmith": "^11.0.0"', 1, 'EG004'],
      ['change the visitor id key', 'apps/dashboard/src/lib/experiments.ts', "'oak-visitor'", "'oak_visitor_id'", 0, 'EG007'],
    ];
    for (const [label, file, from, to, code, rule] of cases) {
      g('checkout', '-q', '-B', 'pr', 'main');
      const p = join(own, file); const src = readFileSync(p, 'utf8');
      if (!src.includes(from)) throw new Error(`${file} no longer contains ${from}`);
      writeFileSync(p, src.replace(from, to)); g('commit', '-qam', label);
      const out = guard(['check', '--base', 'main', '--head', 'pr'], ownEnv, own);
      ok(out.code === code && out.out.includes(rule), `${label}: ${code ? 'blocked' : 'warned'} with ${rule}`);
    }
    g('checkout', '-q', 'main');
  }

  section('Real Flagsmith SDK against the same experiment');
  {
    // The published @flagsmith/flagsmith (a dependency of the dashboard) resolves after npm install.
    const sdk = await import('@flagsmith/flagsmith/isomorphic').catch(() => null);
    if (!sdk) console.log('  - skipped: @flagsmith/flagsmith is not installed (run npm install)');
    else {
      const flagsmith = sdk.createFlagsmithInstance();
      const identifier = `e2e-visitor-${Date.now()}`;
      await flagsmith.init({ environmentID: 'oak_demo', api: `${FS}/api/v1/`, identity: identifier, enableEvents: true, eventProcessorConfig: { eventsApiUrl: `${FS}/api/` } });
      const flag = flagsmith.getExperimentFlag('demo_start');
      ok(['control', 'try_it'].includes(flag?.variant) && flag?.experiment?.inExperiment === true, 'the SDK gets a version of demo_start for an identity', `${flag?.variant}, experiment ${flag?.experiment?.id}`);
      flagsmith.trackEvent('check_run');
      await flagsmith.flushEvents();
      const evs = (await json(`${FS}/__events?env=oak_demo`)).body.filter(e => e.identifier === identifier);
      const exposure = evs.find(e => e.event === '$flag_exposure');
      ok(exposure?.feature_name === 'demo_start' && exposure.value === flag?.variant && exposure.metadata?.experiment_id === 201, 'it sends the exposure, tagged with the experiment');
      ok(evs.some(e => e.event === 'check_run'), 'it sends check_run for the same identity');
      await flagsmith.close?.(1000);
    }
  }

  section('Flagsmith reader (Admin API)');
  let r = guard(['snapshot'], { ...flagsmithEnv, FLAGSMITH_API_KEY: 'wrong' });
  ok(r.code === 2 && /Flagsmith 401/.test(r.out), 'a wrong API key fails loudly');
  r = guard(['snapshot', '--out', join(work, 'snapshot.json')], flagsmithEnv);
  const snap = JSON.parse(readFileSync(join(work, 'snapshot.json'), 'utf8'));
  const byId = Object.fromEntries(snap.experiments.map(e => [e.id, e]));
  ok(snap.experiments.length === 5, 'reads every page of experiments', `${snap.experiments.length} found`);
  ok(byId[101]?.status === 'running' && byId[104]?.status === 'ended' && byId[105]?.status === 'draft', 'maps running / completed / created');
  ok(byId[101]?.flagKey === 'onboarding_flow' && byId[101]?.variationKeys.join() === 'github_first', 'flag key and variant keys from the nested feature');
  ok(byId[101]?.metricEvents.join() === 'issue_opened,github_connected', 'metric events from experiment-metrics');
  ok(byId[101]?.audience?.[0]?.traits.join() === 'visitor_type', 'audience from experiment_rollout (system rollout segment skipped)');
  ok(byId[103]?.audience?.[0]?.traits.join() === 'member_since', 'audience from a segment override on the flag');

  section('CLI on a git repo');
  const cli = (b) => guard(['check', '--base', 'main', '--head', b], flagsmithEnv);
  r = cli('pr-7'); ok(r.code === 0, 'PR 7 passes: it renames an event of a draft experiment');
  r = cli('pr-8'); ok(r.code === 1 && /EG005/.test(r.out), 'PR 8 is blocked: EG005 variant renamed');
  r = cli('pr-9'); ok(r.code === 1 && /EG012/.test(r.out), 'PR 9 is blocked: EG012 audience trait dropped');
  r = cli('pr-10'); ok(r.code === 0, 'PR 10 passes: unrelated change');

  section('GitHub Action path (--format github)');
  const action = (n, b, token = 'ingest-secret', labels = []) => {
    git('checkout', '-q', '--detach', b);
    const event = join(work, `event-${n}.json`);
    writeFileSync(event, JSON.stringify({ number: n, pull_request: { number: n, title: git('log', '-1', '--format=%s'), html_url: `https://github.com/acme/firstpr/pull/${n}`, user: { login: 'newbie' }, head: { ref: b, sha: git('rev-parse', 'HEAD') }, base: { ref: 'main', sha: git('rev-parse', 'main') }, labels: labels.map(name => ({ name })) } }));
    const out = guard(['check', '--format', 'github', '--report-url', OAK], {
      ...flagsmithEnv, GITHUB_REPOSITORY: 'acme/firstpr', GITHUB_EVENT_PATH: event, GITHUB_TOKEN: 'ghs_e2e', GITHUB_API_URL: GH,
      GITHUB_STEP_SUMMARY: join(work, `summary-${n}.md`), OAKENSHIELD_TOKEN: token,
    });
    git('checkout', '-q', 'main');
    return out;
  };
  r = action(8, 'pr-8');
  let gh = await ghState();
  ok(r.code === 1, 'PR 8 fails the job');
  ok(/^::error file=app\/Landing\.tsx,line=12,title=EG005/m.test(r.out), 'writes an error annotation on the changed line');
  ok(gh.requests.some(q => q.method === 'POST' && q.path.endsWith('/pulls/8/reviews') && q.body.comments?.[0]?.body.includes('```suggestion')), 'posts a suggested change as a review');
  ok(gh.comments['acme/firstpr#8']?.length === 1, 'posts one PR comment');
  ok(readFileSync(join(work, 'summary-8.md'), 'utf8').includes('Experiment Guard'), 'writes the job summary');
  r = action(8, 'pr-8');
  gh = await ghState();
  ok(gh.comments['acme/firstpr#8'].length === 1 && gh.requests.filter(q => q.path.endsWith('/pulls/8/reviews')).length === 1, 'a re-run edits the comment and does not repeat suggestions');
  await post(`${GH}/__admin/label`, { repo: 'acme/firstpr', pr: 8, label: 'experiment-guard:override', actor: 'newbie' });
  r = action(8, 'pr-8', 'ingest-secret', ['experiment-guard:override']);
  ok(r.code === 1, 'an override label from someone with read access is refused');
  await post(`${GH}/__admin/label`, { repo: 'acme/firstpr', pr: 8, label: 'experiment-guard:override', actor: 'maintainer1' });
  r = action(8, 'pr-8', 'ingest-secret', ['experiment-guard:override']);
  ok(r.code === 0 && /OVERRIDDEN/.test(r.out), 'an override label from a maintainer is accepted');
  r = action(7, 'pr-7'); ok(r.code === 0, 'PR 7 passes and reports to the dashboard');
  r = action(9, 'pr-9', 'wrong-token'); ok(/dashboard returned 401/.test(r.out), 'the dashboard refuses a report with the wrong token');
  r = action(9, 'pr-9');
  const checks = (await json(`${OAK}/api/checks?limit=50`)).body;
  const list = checks.checks ?? checks.items ?? checks;
  ok(list.some(c => c.pr?.number === 7) && list.some(c => c.pr?.number === 9), 'reports with the right token are stored');

  section('MCP server over stdio');
  {
    writeFileSync(join(repo, 'app/components/IssueCard.tsx'), readFileSync(join(repo, 'app/components/IssueCard.tsx'), 'utf8').replace("trackEvent('issue_opened')", "trackEvent('issueOpened')"));
    const child = spawn(process.execPath, [bin, 'mcp'], { cwd: repo, env: { ...process.env, ...flagsmithEnv }, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    const pending = new Map(); let id = 0;
    readline.createInterface({ input: child.stdout }).on('line', l => { const m = JSON.parse(l); pending.get(m.id)?.(m); });
    const rpc = (method, params) => new Promise(res => { const n = ++id; pending.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    ok(init.result?.serverInfo?.name === 'experiment-guard', 'initialize');
    const tools = await rpc('tools/list', {});
    ok(tools.result.tools.length === 3, 'tools/list', tools.result.tools.map(t => t.name).join(', '));
    const listed = JSON.parse((await rpc('tools/call', { name: 'list_protected_experiments', arguments: {} })).result.content[0].text);
    ok(listed.find(e => e.id === 101)?.audience?.[0]?.traits.join() === 'visitor_type', 'list_protected_experiments includes audience traits');
    const impact = JSON.parse((await rpc('tools/call', { name: 'check_experiment_impact', arguments: {} })).result.content[0].text);
    ok(impact.verdict === 'block' && impact.findings[0]?.rule === 'EG001', 'check_experiment_impact catches an uncommitted event rename');
    child.kill();
    git('checkout', '-q', '--', '.');
  }

  section('Live server');
  const health = (await json(`${OAK}/api/health`)).body;
  ok(health.mode === 'live' && health.flagsmith.source === 'flagsmith-api' && health.flagsmith.running === 3, 'reads Flagsmith in live mode');
  const exps = (await json(`${OAK}/api/experiments`)).body;
  const e101 = (exps.experiments ?? exps).find(e => e.id === 101);
  ok(e101?.references?.length > 0 && e101?.audience?.length === 1, 'experiments carry code references and audience');

  section('Flagsmith webhooks');
  r = await post(WEBHOOK, { event_type: 'FLAG_UPDATED', data: {} });
  ok(r.status === 401, 'an unsigned delivery is refused');
  r = await post(WEBHOOK, { event_type: 'FLAG_UPDATED', data: {} }, { 'X-Flagsmith-Signature': 'deadbeef' });
  ok(r.status === 401, 'a wrongly signed delivery is refused');
  r = await post(`${FS}/__admin/test-webhook/environment`, { targets: [WEBHOOK], secret: SECRET });
  ok(r.body.deliveries[0].status === 200 && r.body.deliveries[0].body.alerts === 0, "Flagsmith's environment test webhook is accepted quietly");
  r = await post(`${FS}/__admin/test-webhook/organisation`, { targets: [WEBHOOK], secret: SECRET });
  ok(r.body.deliveries[0].status === 200 && r.body.deliveries[0].body.alerts === 0, "Flagsmith's organisation test webhook is accepted quietly");

  r = await post(`${FS}/__admin/experiments/105/start`, { targets: [WEBHOOK], secret: SECRET });
  const [flagUpdated, orgCopy, audit] = r.body.deliveries.map(d => d.body);
  ok(flagUpdated.alerts === 2 && flagUpdated.changed.length === 1, 'starting an experiment re-checks open PRs', `PR verdicts changed: ${flagUpdated.changed.length}`);
  ok(orgCopy.duplicate === true && audit.alerts === 0, 'the organisation copy and audit entry add nothing');
  gh = await ghState();
  const pr7 = gh.comments['acme/firstpr#7'];
  ok(pr7.at(-1).body.includes('Re-checked after a change in Flagsmith') && pr7.at(-1).body.includes('EG001'), 'PR 7 comment now says it is blocked');
  ok(gh.requests.some(q => q.path.includes('/statuses/') && q.body.state === 'failure' && q.body.context === 'Experiment Guard (Flagsmith)'), 'PR 7 gets a failing commit status');

  r = await post(`${FS}/__admin/segments/7001/property`, { property: 'locale', targets: [WEBHOOK], secret: SECRET });
  ok(r.body.deliveries[0].body.alerts === 2 && r.body.deliveries[0].body.changed.length === 1, 'editing the audience segment re-checks PRs');
  gh = await ghState();
  ok(gh.comments['acme/firstpr#9'].at(-1).body.includes('no running experiments affected'), 'PR 9 passes once the segment no longer uses visitor_type');
  ok(gh.requests.some(q => q.path.includes('/statuses/') && q.body.state === 'success'), 'PR 9 gets a passing commit status');

  const alerts = (await json(`${OAK}/api/alerts?limit=20`)).body;
  const kinds = (alerts.alerts ?? alerts).map(a => a.kind);
  ok(['experiment-started', 'segment-change', 'recheck'].every(k => kinds.includes(k)), 'alerts are stored for the dashboard', kinds.join(', '));
} catch (err) {
  failures++;
  console.error(`\n${err.stack ?? err}`);
} finally {
  // Let the servers exit (the dashboard server writes its data file on the way out) before cleaning up.
  await Promise.all(children.map(c => c.exitCode !== null || c.signalCode ? null : new Promise(r => { c.once('exit', r); c.kill(); setTimeout(r, 2000); })));
  if (process.env.E2E_KEEP) console.log(`\nKept ${work}`);
  else rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
  process.exit(failures ? 1 : 0);
}
