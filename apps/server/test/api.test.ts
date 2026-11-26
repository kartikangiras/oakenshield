import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { loadScenarioSet } from '@oakenshield/guard';
import { createApp } from '../src/app.ts';
import { ExperimentService } from '../src/experiments.ts';
import { generateDemoChecks } from '../src/seed.ts';
import { Store } from '../src/store.ts';

const scenarios = loadScenarioSet();
let base = '';
let close: () => void;

before(async () => {
  const store = new Store(null);
  const experiments = new ExperimentService({ mode: 'demo', config: scenarios.config, demoFiles: scenarios.baseFiles });
  await experiments.refresh();
  store.replaceChecks(generateDemoChecks({ set: scenarios, snapshot: experiments.snapshot!, config: scenarios.config }), new Date().toISOString());
  const { server } = createApp({
    store, experiments, scenarios, baseConfig: scenarios.config, ingestToken: 'secret',
    client: { experiments: { environmentKey: 'oak_demo_client_key' } },
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const get = async (path: string): Promise<{ status: number; body: Json }> => {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
};
const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Json }> => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

describe('API', () => {
  it('reports health and mode', async () => {
    const { body } = await get('/api/health');
    assert.equal(body.mode, 'demo');
    assert.equal(body.flagsmith.running, 3);
    assert.equal(body.ingestProtected, true);
  });

  it("serves the dashboard's public settings, including its own A/B test environment", async () => {
    const { status, body } = await get('/api/client-config');
    assert.equal(status, 200);
    assert.deepEqual(body, { experiments: { environmentKey: 'oak_demo_client_key' } });
  });

  it('builds an overview with a filled daily series', async () => {
    const { body } = await get('/api/overview?days=30');
    assert.equal(body.series.length, 30);
    assert.ok(body.kpis.checks > 0);
    assert.ok(body.kpis.checksPrev > 0);
    const total = body.series.reduce((n: number, p: { pass: number; warn: number; block: number; overridden: number }) => n + p.pass + p.warn + p.block + p.overridden, 0);
    assert.equal(total, body.kpis.checks);
  });

  it('lists experiments with code references', async () => {
    const { body } = await get('/api/experiments');
    const onb = body.find((e: { flagKey: string }) => e.flagKey === 'onboarding_flow');
    assert.ok(onb.references.some((r: { kind: string }) => r.kind === 'exposure'));
    assert.ok(onb.references.some((r: { kind: string }) => r.kind === 'conversion'));
    const detail = await get(`/api/experiments/${onb.id}`);
    assert.ok(Array.isArray(detail.body.recentChecks));
  });

  it('runs a playground scenario and stores it', async () => {
    const created = await send('POST', '/api/checks', { scenarioId: 'variant-key-rename' });
    assert.equal(created.status, 201);
    assert.equal(created.body.verdict, 'block');
    assert.match(created.body.markdown, /EG005/);
    const fetched = await get(`/api/checks/${created.body.id}`);
    assert.equal(fetched.body.id, created.body.id);
  });

  it('checks a pasted diff', async () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-flagsmith.trackEvent('mentor_requested')\n+flagsmith.trackEvent('mentorRequested')\n";
    const { status, body } = await send('POST', '/api/checks', { diff });
    assert.equal(status, 201);
    assert.equal(body.findings[0].rule, 'EG001');
  });

  it('rejects bad input', async () => {
    assert.equal((await send('POST', '/api/checks', { diff: 'not a diff' })).status, 400);
    assert.equal((await send('PUT', '/api/rules/EG001', { severity: 'loud' })).status, 400);
    assert.equal((await get('/api/checks/nope')).status, 404);
  });

  it('applies rule severity changes to new checks', async () => {
    await send('PUT', '/api/rules/EG006', { severity: 'off' });
    const { body } = await send('POST', '/api/checks', { scenarioId: 'edit-connect-wall' });
    assert.equal(body.verdict, 'pass');
    await send('PUT', '/api/rules/EG006', { severity: 'warn' });
  });

  it('requires the token to ingest CI reports', async () => {
    const report = { tool: 'experiment-guard', version: 1, verdict: 'pass', findings: [], counts: { block: 0, warn: 0, info: 0, ignored: 0 }, stats: { filesChanged: 1, linesAdded: 1, linesRemoved: 0, filesScanned: 1 }, snapshot: { fetchedAt: new Date().toISOString(), source: 'file', running: 1 }, affectedExperiments: [], createdAt: new Date().toISOString(), durationMs: 5, toolVersion: '0.1.0', repo: 'acme/web', source: 'ci' };
    assert.equal((await send('POST', '/api/reports', report)).status, 401);
    const ok = await send('POST', '/api/reports', report, { authorization: 'Bearer secret' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.repo, 'acme/web');
  });

  it('filters checks by verdict, repo and text', async () => {
    const { body } = await get('/api/checks?verdict=block&repo=oakenshield/firstpr&limit=5');
    assert.ok(body.items.every((c: { verdict: string; repo: string }) => c.verdict === 'block' && c.repo === 'oakenshield/firstpr'));
    const q = await get('/api/checks?q=EG004');
    assert.ok(q.body.items.every((c: { rules: string[] }) => c.rules.includes('EG004')));
  });

  it('streams events over SSE', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: hello/);
    await send('POST', '/api/checks', { scenarioId: 'css-only' });
    const next = new TextDecoder().decode((await reader.read()).value);
    assert.match(next, /event: check/);
    ctrl.abort();
  });
});
