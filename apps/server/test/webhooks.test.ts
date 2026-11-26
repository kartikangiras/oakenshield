import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadScenarioSet } from '@oakenshield/guard';
import { createApp } from '../src/app.ts';
import { ExperimentService } from '../src/experiments.ts';
import { generateDemoChecks } from '../src/seed.ts';
import { Store } from '../src/store.ts';
import { gitHubPoster, parseEvent, simulatedPayload } from '../src/webhooks.ts';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SECRET = 'whsec_test';
const scenarios = loadScenarioSet();
let base = '';
let gh = '';
const ghCalls: Array<{ method: string; url: string; body: Json }> = [];
const servers: Server[] = [];

before(async () => {
  // A fake GitHub API that records what the re-check writes back.
  const fake = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    ghCalls.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && /\/pulls\/\d+$/.test(req.url!)) return res.end(JSON.stringify({ state: 'open' }));
    if (req.method === 'GET' && req.url!.includes('/comments')) return res.end('[]');
    res.statusCode = 201;
    res.end('{}');
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  gh = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  servers.push(fake);

  const store = new Store(null);
  const experiments = new ExperimentService({ mode: 'demo', config: scenarios.config, demoFiles: scenarios.baseFiles });
  await experiments.refresh();
  store.replaceChecks(generateDemoChecks({ set: scenarios, snapshot: experiments.snapshot!, config: scenarios.config }), new Date().toISOString());
  const { server } = createApp({ store, experiments, scenarios, baseConfig: scenarios.config, webhookSecret: SECRET, github: gitHubPoster('t0ken', gh) });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
});
after(() => servers.forEach(s => s.close()));

const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex');
const deliver = async (payload: unknown, signature?: string) => {
  const body = JSON.stringify(payload);
  const res = await fetch(`${base}/api/webhooks/flagsmith`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-flagsmith-signature': signature ?? sign(body) }, body });
  return { status: res.status, body: (await res.json()) as Json };
};
const post = async (path: string, body: unknown) => {
  const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Json };
};
const get = async (path: string): Promise<Json> => (await fetch(base + path)).json();

describe('Flagsmith webhooks', () => {
  it('parses flag updates into readable changes', () => {
    const ev = parseEvent(simulatedPayload('change-weights'));
    assert.equal(ev.flagKey, 'onboarding_flow');
    assert.deepEqual(ev.changes, ['variation weights github_first 50% → github_first 70%']);
  });

  it('rejects deliveries with a missing or wrong signature', async () => {
    assert.equal((await deliver({ event_type: 'FLAG_UPDATED', data: {} }, 'nope')).status, 401);
    const res = await fetch(`${base}/api/webhooks/flagsmith`, { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  it('alerts when a running experiment’s flag changes in Flagsmith', async () => {
    const r = await deliver(simulatedPayload('change-weights'));
    assert.equal(r.status, 200);
    assert.equal(r.body.alerts, 1);
    const [alert] = await get('/api/alerts?limit=1');
    assert.equal(alert.kind, 'config-change');
    assert.equal(alert.severity, 'warn');
    assert.equal(alert.flagKey, 'onboarding_flow');
    assert.match(alert.detail, /github_first 50% → github_first 70%/);
    assert.match(alert.detail, /kim@acme\.dev/);
  });

  it('drops the duplicate deliveries Flagsmith sends to environment and organisation webhooks', async () => {
    const payload = simulatedPayload('change-weights');
    const first = await deliver(payload);
    const second = await deliver(payload);
    assert.equal(first.body.duplicate, false);
    assert.equal(second.body.duplicate, true);
    assert.equal(second.body.alerts, 0);
  });

  it('does not repeat flag alerts from the audit log', async () => {
    const r = await deliver({ event_type: 'AUDIT_LOG_CREATED', data: { created_date: new Date().toISOString(), log: 'Flag state updated for feature: onboarding_flow', related_object_type: 'FEATURE_STATE', author: { email: 'kim@acme.dev' } } });
    assert.equal(r.body.alerts, 0);
  });

  it('alerts when an audience segment changes', async () => {
    const r = await deliver(simulatedPayload('edit-segment'));
    assert.equal(r.body.alerts, 1);
    const [alert] = await get('/api/alerts?limit=1');
    assert.equal(alert.kind, 'segment-change');
    assert.equal(alert.experimentName, 'Connect-first onboarding');
  });

  it('ignores events about flags no experiment uses', async () => {
    const r = await deliver({ event_type: 'FLAG_UPDATED', data: { changed_by: 'x', new_state: { enabled: true, feature: { name: 'dark_mode' } }, previous_state: { enabled: false, feature: { name: 'dark_mode' } } } });
    assert.equal(r.body.alerts, 0);
  });

  it('re-checks open pull requests when an experiment starts, and writes back to GitHub', async () => {
    const docsBefore = (await get('/api/checks?repo=oakenshield/docs-site&limit=500')).items.filter((c: Json) => c.pr?.number >= 420);
    assert.ok(docsBefore.every((c: Json) => c.verdict === 'pass'));
    ghCalls.length = 0;

    const r = await post('/api/flagsmith/simulate', { kind: 'start-experiment' });
    assert.equal(r.status, 200);
    const kinds = r.body.alerts.map((a: Json) => a.kind);
    assert.deepEqual(kinds, ['experiment-started', 'recheck']);
    const changed = r.body.changed.map((c: Json) => [c.pr.number, c.verdict, c.rules]);
    assert.deepEqual(changed.sort(), [[420, 'block', ['EG001']], [421, 'block', ['EG005']]]);
    assert.equal(r.body.alerts[1].severity, 'block');

    const comment = ghCalls.filter(c => c.method === 'POST' && /\/issues\/\d+\/comments$/.test(c.url));
    const status = ghCalls.filter(c => c.method === 'POST' && c.url.includes('/statuses/'));
    assert.equal(comment.length, 2);
    assert.match(comment[0].body.body, /Re-checked after a change in Flagsmith: "Sticky docs sign-up CTA" started/);
    assert.ok(status.every(s => s.body.state === 'failure' && s.body.context === 'Experiment Guard (Flagsmith)'));

    const detail = await get(`/api/checks/${r.body.changed[0].id}`);
    assert.equal(detail.source, 'webhook');
  });

  it('does nothing new when the same event arrives twice', async () => {
    const r = await post('/api/flagsmith/simulate', { kind: 'start-experiment' });
    assert.equal(r.body.changed.length, 0);
  });

  it('reports webhook status in health', async () => {
    const h = await get('/api/health');
    assert.equal(h.webhooks.secretSet, true);
    assert.equal(h.webhooks.github, true);
    assert.ok(h.webhooks.received >= 3);
  });
});
