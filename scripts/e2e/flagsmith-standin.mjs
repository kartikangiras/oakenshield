// A local stand-in for Flagsmith, built from Flagsmith's own source so Oakenshield can be run end to
// end without a Flagsmith account:
//   - the Admin API Experiment Guard reads (api/experimentation/serializers.py, features/,
//     segments/, environments/), for two environments: demo_prod (the FirstPR demo project) and
//     oak_demo (Oakenshield's own A/B test, docs/experiment.md);
//   - the SDK API the real @flagsmith/flagsmith SDK calls: flags/, identities/ with each flag's
//     variant and experiment metadata (features/serializers.py SDKIdentityFeatureStateSerializer,
//     experimentation/feature_state_metadata.py), and v1/events for exposures and conversions;
//   - real-format, signed webhooks, the way Flagsmith's webhook task sends them.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9100);
const KEY = process.env.STANDIN_KEY ?? 'e2e-org-key';
const ENV_KEY = 'demo_prod';
const ORIGIN = `http://127.0.0.1:${PORT}`;
const log = (...a) => process.stdout.write(a.join(' ') + '\n');

const project = { id: 7, name: 'FirstPR' };
const environment = { id: 3, uuid: 'b9c1f0de-0000-4000-8000-000000000003', name: 'Production', api_key: ENV_KEY, project: 7, use_v2_feature_versioning: false, minimum_change_request_approvals: null };
// Oakenshield's own A/B test lives in a second environment (same project here, for brevity).
const OAK_KEY = 'oak_demo';
const environments = {
  [ENV_KEY]: environment,
  [OAK_KEY]: { id: 5, uuid: 'b9c1f0de-0000-4000-8000-000000000005', name: 'Oakenshield demo', api_key: OAK_KEY, project: 7, use_v2_feature_versioning: false, minimum_change_request_approvals: null },
};

const opt = (id, key, pct) => ({ id, uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`, type: 'unicode', integer_value: null, string_value: key, boolean_value: null, default_percentage_allocation: pct, key });
const features = {
  9001: { id: 9001, name: 'onboarding_flow', type: 'MULTIVARIATE', initial_value: 'value_first', multivariate_options: [opt(51, 'github_first', 50)] },
  9002: { id: 9002, name: 'mentor_match', type: 'MULTIVARIATE', initial_value: 'directory', multivariate_options: [opt(52, 'match_quiz', 50)] },
  9003: { id: 9003, name: 'search_ranking', type: 'MULTIVARIATE', initial_value: 'bm25', multivariate_options: [opt(53, 'semantic', 33), opt(54, 'hybrid', 33)] },
  9004: { id: 9004, name: 'digest_prompt', type: 'MULTIVARIATE', initial_value: 'control', multivariate_options: [opt(55, 'show-prompt', 50)] },
  9005: { id: 9005, name: 'docs_cta', type: 'MULTIVARIATE', initial_value: 'inline', multivariate_options: [opt(61, 'sticky', 0)] },
  9101: { id: 9101, name: 'demo_start', type: 'MULTIVARIATE', initial_value: 'overview', multivariate_options: [opt(71, 'try_it', 50)] },
};
const featuresByEnv = { [ENV_KEY]: [9001, 9002, 9003, 9004, 9005], [OAK_KEY]: [9101] };
const metrics = {
  501: { name: 'Issue opened', event: 'issue_opened' }, 502: { name: 'GitHub connected', event: 'github_connected' },
  503: { name: 'Mentor requested', event: 'mentor_requested' }, 504: { name: 'Result clicked', event: 'result_clicked' },
  505: { name: 'Search refined', event: 'search_refined' }, 506: { name: 'Digest subscribed', event: 'digest_subscribed' },
  507: { name: 'Sign-up started', event: 'signup_started' },
  601: { name: 'Ran a check', event: 'check_run' }, 602: { name: 'Copied a set-up snippet', event: 'setup_snippet_copied' },
};
const segments = {
  7001: { id: 7001, uuid: 'seg-7001', name: 'First-time visitors', description: 'Visitors on their first session', project: 7, feature: null, is_system_segment: false,
    rules: [{ type: 'ALL', rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'EQUAL', property: 'visitor_type', value: 'new', description: null }] }], conditions: [] }] },
  7002: { id: 7002, uuid: 'seg-7002', name: 'Signed-in members', description: null, project: 7, feature: null, is_system_segment: false,
    rules: [{ type: 'ALL', rules: [{ type: 'ANY', rules: [], conditions: [{ operator: 'IS_SET', property: 'member_since', value: null, description: null }] }], conditions: [] }] },
  // The system "rollout segment" Flagsmith creates for an experiment: never listed, never fetched by clients.
  77: { id: 77, name: '__experiment_rollout_101', is_system_segment: true, rules: [] },
};
const now = Date.now();
const iso = ms => new Date(ms).toISOString();
const experiments = [
  { id: 101, feature: 9001, name: 'Connect-first onboarding', hypothesis: 'Asking for GitHub first gets more people to their first issue.', status: 'running', metrics: [501, 502], started_at: iso(now - 9 * 864e5), ended_at: null, audience: [7001] },
  { id: 102, feature: 9002, name: 'Mentor matching quiz', hypothesis: null, status: 'running', metrics: [503], started_at: iso(now - 5 * 864e5), ended_at: null, audience: [] },
  { id: 103, feature: 9003, name: 'Search ranking v2', hypothesis: null, status: 'running', metrics: [504, 505], started_at: iso(now - 3 * 864e5), ended_at: null, audience: [] },
  { id: 104, feature: 9004, name: 'Weekly digest prompt', hypothesis: null, status: 'completed', metrics: [506], started_at: iso(now - 40 * 864e5), ended_at: iso(now - 12 * 864e5), audience: [] },
  { id: 105, feature: 9005, name: 'Sticky docs sign-up CTA', hypothesis: null, status: 'created', metrics: [507], started_at: null, ended_at: null, audience: [] },
  { id: 201, env: OAK_KEY, feature: 9101, name: 'Open the demo on a broken pull request', hypothesis: 'Opening the demo on a broken pull request gets more first-time visitors to run a check than opening it on the overview.', status: 'running', metrics: [601, 602], started_at: iso(now), ended_at: null, audience: [] },
];
const inEnv = (e, key) => (e.env ?? ENV_KEY) === key;
// Segment overrides on flags in this environment (features/feature-segments/). 103's audience is
// set this way; 101's experiment has a system rollout segment plus its own audience.
const featureSegments = [
  { id: 801, uuid: 'fs-801', segment: 7002, priority: 0, environment: 3, segment_name: 'Signed-in members', is_feature_specific: false, is_system_segment: false, segment_managed_by: null, feature: 9003 },
  { id: 802, uuid: 'fs-802', segment: 77, priority: 1, environment: 3, segment_name: '__experiment_rollout_101', is_feature_specific: false, is_system_segment: true, segment_managed_by: 'EXPERIMENT', feature: 9001 },
];

const listItem = ({ env: _env, ...e }) => ({
  id: e.id, feature: features[e.feature], name: e.name, hypothesis: e.hypothesis, status: e.status,
  metrics: e.metrics.map((m, i) => ({ id: e.id * 10 + i, metric: m, metric_name: metrics[m].name, aggregation: 'count', direction: 'increase', expected_direction: 'increase', created_at: e.started_at ?? iso(now) })),
  created_at: iso(now - 50 * 864e5), updated_at: iso(now), started_at: e.started_at, ended_at: e.ended_at,
});
const detail = e => ({
  ...listItem(e),
  experiment_rollout: e.status === 'created' ? null : {
    enabled: true, rollout_percentage: 100, feature_state_value: { type: 'unicode', value: features[e.feature].initial_value },
    multivariate_feature_state_values: features[e.feature].multivariate_options.map(o => ({ multivariate_feature_option: o.id, percentage_allocation: o.default_percentage_allocation })),
    audience: { match: 'ANY', segments: e.audience.map(id => ({ id, name: segments[id].name, is_cohort: false, cohort_source_type: null, deleted: false })) },
  },
});

// CORS, so the SDK can call the stand-in from a page on another port, as browsers do with Flagsmith.
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', ...CORS }); res.end(JSON.stringify(body)); };

// ---- SDK side ---------------------------------------------------------------------------------
const received = []; // every event the SDK sent: { env, event, feature_name, identifier, value, metadata, timestamp }

/** Deterministic bucketing per experiment and identity, like Flagsmith's hashing (not the same numbers). */
function bucket(experimentId, identifier) {
  return parseInt(crypto.createHash('sha256').update(`${experimentId}:${identifier}`).digest('hex').slice(0, 8), 16) % 100;
}
/** One flag as SDKIdentityFeatureStateSerializer renders it for this identity. */
function sdkFlag(envKey, f, identifier) {
  const base = { feature: { id: f.id, name: f.name, type: f.type }, enabled: true, feature_state_value: f.initial_value };
  const exp = experiments.find(e => e.feature === f.id && e.status === 'running' && inEnv(e, envKey));
  if (!identifier || !exp) return base;
  // Rollout 100%: every identity is in the experiment's rollout segment, so in_experiment is true.
  let b = bucket(exp.id, identifier), chosen = null;
  for (const o of f.multivariate_options) { if (b < o.default_percentage_allocation) { chosen = o; break; } b -= o.default_percentage_allocation; }
  return {
    ...base,
    feature_state_value: chosen ? chosen.string_value : f.initial_value,
    variant: chosen ? chosen.key : 'control',
    metadata: { experiment: { id: exp.id, name: exp.name, in_experiment: true } },
  };
}
const sdkFlags = (envKey, identifier) => (featuresByEnv[envKey] ?? []).map(id => sdkFlag(envKey, features[id], identifier));

/**
 * Counts per variation, from the events received: identities exposed (first exposure wins; an
 * identity seen in two variations is quarantined) and how many of them sent each metric's event at
 * least once (occurrence). Plain counts, not Flagsmith's Bayesian statistics.
 */
function results(envKey) {
  return experiments.filter(e => inEnv(e, envKey) && e.status === 'running').map(e => {
    const flag = features[e.feature].name;
    const seen = new Map(), quarantined = new Set();
    for (const ev of received) {
      if (ev.env !== envKey || ev.event !== '$flag_exposure' || ev.feature_name !== flag || ev.metadata?.experiment_id !== e.id) continue;
      const before = seen.get(ev.identifier);
      if (before && before !== ev.value) quarantined.add(ev.identifier);
      else seen.set(ev.identifier, ev.value);
    }
    const variations = {};
    for (const [id, v] of seen) {
      if (quarantined.has(id)) continue;
      const row = (variations[v] ??= { identities: 0, conversions: Object.fromEntries(e.metrics.map(m => [metrics[m].event, 0])) });
      row.identities++;
      for (const m of e.metrics) if (received.some(ev => ev.env === envKey && ev.identifier === id && ev.event === metrics[m].event)) row.conversions[metrics[m].event]++;
    }
    return { experiment: e.id, name: e.name, flag, variations, quarantined: quarantined.size };
  });
}
const readBody = req => new Promise(r => { let b = ''; req.on('data', c => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : {})); });

// Builds a webhook body in the shape of environments/models.py + features/tasks.py.
function flagState(f, enabled, pcts) {
  return {
    feature: { id: f.id, created_date: iso(now - 60 * 864e5), default_enabled: false, description: null, initial_value: f.initial_value, name: f.name, project, type: f.type },
    environment: { id: environment.id, name: environment.name }, identity: null, identity_identifier: null, feature_segment: null, enabled,
    feature_state_value: f.initial_value,
    multivariate_feature_state_values: f.multivariate_options.map((o, i) => ({ id: 900 + i, multivariate_feature_option: { id: o.id, value: o.string_value }, percentage_allocation: pcts[i] ?? o.default_percentage_allocation })),
  };
}
// Python's json.dumps(x, sort_keys=True): sorted keys, ", " and ": " separators, ASCII escapes.
function pyDumps(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Array.isArray(x)) return '[' + x.map(pyDumps).join(', ') + ']';
  return '{' + Object.keys(x).sort().map(k => pyDumps(k) + ': ' + pyDumps(x[k])).join(', ') + '}';
}
async function fire(target, secret, payload) {
  // webhooks/webhooks.py: json_data = json.dumps(data, sort_keys=True); signed with
  // core.signing.sign_payload (hex HMAC-SHA256) and POSTed as the body.
  const body = pyDumps(payload);
  const headers = { 'content-type': 'application/json' };
  if (secret) headers['X-Flagsmith-Signature'] = crypto.createHmac('sha256', secret).update(body).digest('hex');
  const r = await fetch(target, { method: 'POST', headers, body });
  return { status: r.status, body: await r.json().catch(() => null) };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  const p = url.pathname;
  if (p.startsWith('/__admin/')) {
    // Test controls: change state the way a user would in Flagsmith's UI, then deliver the webhooks
    // Flagsmith would send for that change (environment FLAG_UPDATED, organisation FLAG_UPDATED + audit log).
    const body = await readBody(req);
    const deliveries = [];
    const deliver = async payload => { for (const t of body.targets ?? []) deliveries.push(await fire(t, body.secret, payload)); };
    let m;
    if ((m = p.match(/^\/__admin\/experiments\/(\d+)\/start$/))) {
      const e = experiments.find(x => x.id === Number(m[1]));
      const f = features[e.feature];
      const prev = flagState(f, false, f.multivariate_options.map(o => o.default_percentage_allocation));
      e.status = 'running'; e.started_at = iso(Date.now());
      f.multivariate_options.forEach(o => (o.default_percentage_allocation = 50));
      const next = flagState(f, true, f.multivariate_options.map(() => 50));
      const flagEvent = { event_type: 'FLAG_UPDATED', data: { changed_by: 'kim@acme.dev', timestamp: iso(Date.now()), new_state: next, previous_state: prev } };
      await deliver(flagEvent); await deliver(flagEvent);
      await deliver({ event_type: 'AUDIT_LOG_CREATED', data: { id: 1001, created_date: iso(Date.now()), log: `Experiment '${e.name}' rollout set to 100% of all identities`, author: { id: 4, email: 'kim@acme.dev', first_name: 'Kim', last_name: 'Lee' }, organisation: { id: 1, name: 'Acme' }, environment: { id: 3, name: 'Production' }, project, related_object_id: e.id, related_object_uuid: null, related_object_type: 'EXPERIMENT', is_system_event: false } });
      log('ADMIN start', e.id, JSON.stringify(deliveries.map(d => d.body)));
      return send(res, 200, { ok: true, deliveries });
    }
    if ((m = p.match(/^\/__admin\/experiments\/(\d+)\/complete$/))) {
      const e = experiments.find(x => x.id === Number(m[1]));
      e.status = 'completed'; e.ended_at = iso(Date.now());
      await deliver({ event_type: 'AUDIT_LOG_CREATED', data: { id: 1002, created_date: iso(Date.now()), log: `Experiment completed: ${e.name}`, author: { id: 4, email: 'kim@acme.dev' }, organisation: { id: 1, name: 'Acme' }, environment: { id: 3, name: 'Production' }, project, related_object_id: e.id, related_object_uuid: null, related_object_type: 'EXPERIMENT', is_system_event: false } });
      log('ADMIN complete', e.id, JSON.stringify(deliveries.map(d => d.body)));
      return send(res, 200, { ok: true, deliveries });
    }
    if ((m = p.match(/^\/__admin\/segments\/(\d+)\/property$/))) {
      const sg = segments[Number(m[1])];
      sg.rules[0].rules[0].conditions[0].property = body.property;
      await deliver({ event_type: 'AUDIT_LOG_CREATED', data: { id: 1003, created_date: iso(Date.now()), log: `Segment updated: ${sg.name}`, author: { id: 4, email: 'kim@acme.dev' }, organisation: { id: 1, name: 'Acme' }, environment: null, project, related_object_id: sg.id, related_object_uuid: sg.uuid, related_object_type: 'SEGMENT', is_system_event: false } });
      log('ADMIN segment', sg.id, body.property, JSON.stringify(deliveries.map(d => d.body)));
      return send(res, 200, { ok: true, deliveries });
    }
    if (p === '/__admin/test-webhook/environment') {
      // generate_environment_sample_webhook_data(): what Flagsmith's "Test webhook" button sends.
      const st = (enabled, value) => ({ feature: { id: 1, created_date: '2021-02-10T20:03:43.348556Z', default_enabled: false, description: 'This is a description', initial_value: null, name: 'test_feature', project: { id: 1, name: 'Test Project' }, type: 'CONFIG' }, environment: { id: 1, name: 'Development' }, identity: 1, identity_identifier: 'test_identity', feature_segment: null, enabled, feature_state_value: value, multivariate_feature_state_values: [{ id: 1, multivariate_feature_option: { id: 1, value: 'variant_a' }, percentage_allocation: 50 }] });
      await deliver({ data: { changed_by: 'user@domain.com', timestamp: '2021-06-18T07:50:26.595298Z', new_state: st(true, 'feature_state_value'), previous_state: st(false, 'old_feature_state_value') }, event_type: 'FLAG_UPDATED' });
      return send(res, 200, { ok: true, deliveries });
    }
    if (p === '/__admin/test-webhook/organisation') {
      await deliver({ data: { created_date: '2020-02-23T17:30:57.006318Z', log: 'New Flag / Remote Config created: my_feature', author: { id: 1, email: 'user@domain.com', first_name: 'Jane', last_name: 'Doe' }, environment: null, project: { id: 1, name: 'Test Project', organisation: 1 }, related_object_id: 1, related_object_type: 'FEATURE' }, event_type: 'AUDIT_LOG_CREATED' });
      return send(res, 200, { ok: true, deliveries });
    }
    return send(res, 404, { detail: 'unknown admin route' });
  }

  // SDK API: authenticated by the environment key header, like Flagsmith's.
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
  if (p === '/api/v1/flags/' || p === '/api/v1/identities/' || p === '/api/v1/events') {
    const envKey = req.headers['x-environment-key'];
    log(req.method, p + url.search, `env=${envKey}`);
    if (!environments[envKey]) return send(res, 401, { detail: 'Invalid or missing X-Environment-Key' });
    if (p === '/api/v1/flags/') return send(res, 200, sdkFlags(envKey, null));
    if (p === '/api/v1/identities/') {
      const body = req.method === 'POST' ? await readBody(req) : {};
      const identifier = body.identifier ?? url.searchParams.get('identifier');
      return send(res, 200, { identifier, flags: sdkFlags(envKey, identifier), traits: [] });
    }
    const body = await readBody(req);
    for (const ev of body.events ?? []) received.push({ env: envKey, ...ev });
    return send(res, 202, {});
  }
  if (p === '/__results') return send(res, 200, { events: received.length, experiments: results(url.searchParams.get('env') ?? OAK_KEY) });
  if (p === '/__events') return send(res, 200, received.filter(e => !url.searchParams.get('env') || e.env === url.searchParams.get('env')));

  log('GET', p + url.search, req.headers.authorization === `Api-Key ${KEY}` ? 'auth=ok' : 'auth=BAD');
  if (req.headers.authorization !== `Api-Key ${KEY}`) return send(res, 401, { detail: 'Authentication credentials were not provided.' });
  let m;
  const envMatch = p.match(/^\/api\/v1\/environments\/([^/]+)\//);
  const envKey = envMatch?.[1];
  if (envKey && !environments[envKey]) return send(res, 404, { detail: 'Not found.' });
  const envExperiments = experiments.filter(e => inEnv(e, envKey));
  if (p === `/api/v1/environments/${envKey}/`) return send(res, 200, environments[envKey]);
  if (p === `/api/v1/environments/${envKey}/experiments/`) {
    // PageNumberPagination; a small page size here exercises the `next` link.
    const page = Number(url.searchParams.get('page') ?? 1), size = 3;
    const items = envExperiments.slice((page - 1) * size, page * size).map(listItem);
    const more = page * size < envExperiments.length;
    const counts = Object.fromEntries(['created', 'running', 'paused', 'completed'].map(s => [s, envExperiments.filter(e => e.status === s).length]));
    return send(res, 200, { count: envExperiments.length, next: more ? `${ORIGIN}/api/v1/environments/${envKey}/experiments/?page=${page + 1}` : null, previous: page > 1 ? `${ORIGIN}/api/v1/environments/${envKey}/experiments/?page=${page - 1}` : null, results: items, status_counts: counts });
  }
  if ((m = p.match(/^\/api\/v1\/environments\/[^/]+\/experiments\/(\d+)\/$/))) {
    const e = envExperiments.find(x => x.id === Number(m[1]));
    return e ? send(res, 200, detail(e)) : send(res, 404, { detail: 'Not found.' });
  }
  if ((m = p.match(/^\/api\/v1\/environments\/[^/]+\/experiment-metrics\/(\d+)\/$/))) {
    const x = metrics[Number(m[1])];
    return x ? send(res, 200, { id: Number(m[1]), name: x.name, description: '', aggregation: 'count', direction: 'increase', definition: { version: 1, event: x.event }, experiments: [] }) : send(res, 404, { detail: 'Not found.' });
  }
  if ((m = p.match(/^\/api\/v1\/projects\/7\/segments\/(\d+)\/$/))) {
    const sg = segments[Number(m[1])];
    return sg && !sg.is_system_segment ? send(res, 200, sg) : send(res, 404, { detail: 'Not found.' });
  }
  if (p === '/api/v1/features/feature-segments/') {
    const feature = Number(url.searchParams.get('feature'));
    return send(res, 200, featureSegments.filter(f => f.feature === feature && String(f.environment) === url.searchParams.get('environment')).map(({ feature: _f, ...rest }) => rest));
  }
  if ((m = p.match(/^\/api\/v1\/projects\/7\/features\/(\d+)\/$/))) return features[m[1]] ? send(res, 200, { ...features[m[1]], project: 7 }) : send(res, 404, { detail: 'Not found.' });
  return send(res, 404, { detail: 'Not found.' });
}).listen(PORT, '127.0.0.1', () => log(`flagsmith stand-in on ${ORIGIN}`));
