import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractTraits, readFromFlagsmith, segmentTraits } from '../src/index.ts';

const lines = (s: string) => s.split('\n').map((text, i) => ({ line: i + 1, text }));

describe('trait extraction', () => {
  it('reads init options, setTrait, setTraits and identify', () => {
    const t = extractTraits(lines([
      "flagsmith.init({ identity: id, traits: { plan: user.plan, beta } });",
      "flagsmith.setTrait('seats', team.size);",
      'await flagsmith.setTraits({',
      "  'region': geo(req, { fallback: 'eu' }),",
      '  ...rest,',
      '});',
      'flagsmith.identify(user.id, { role: user.role });',
    ].join('\n')));
    assert.deepEqual(t.map(x => [x.key, x.line]), [['plan', 1], ['beta', 1], ['seats', 2], ['region', 4], ['role', 7]]);
    assert.equal(t.find(x => x.key === 'region')!.value, "geo(req, { fallback: 'eu' })");
  });

  it('reads Python traits= dicts and ignores comments', () => {
    const t = extractTraits(lines('flags = fs.get_identity_flags(user.id, traits={"plan": user.plan})  # {not: traits}'));
    assert.deepEqual(t.map(x => x.key), ['plan']);
  });

  it('ignores objects that are not traits', () => {
    assert.deepEqual(extractTraits(lines("const options = { plan: 'pro' }; track('x', { plan: 'pro' });")), []);
  });
});

describe('segment traits', () => {
  it('walks nested rules and both property spellings', () => {
    const seg = { rules: [{ type: 'ALL', rules: [{ type: 'ANY', conditions: [{ property: 'plan', operator: 'EQUAL', value: 'pro' }, { property_: 'country' }, { operator: 'PERCENTAGE_SPLIT', value: '10' }] }] }] };
    assert.deepEqual(segmentTraits(seg), ['plan', 'country']);
  });
});

describe('reading experiments from Flagsmith (response shapes from Flagsmith\'s API source)', () => {
  it('reads flag, variations, metric events and audience traits', async () => {
    const calls: string[] = [];
    const api: Record<string, unknown> = {
      // ExperimentListSerializer: nested feature with multivariate options (with key), metrics by id
      'environments/env_key/experiments/': {
        count: 2, next: null, previous: null, status_counts: { created: 1, running: 1, paused: 0, completed: 0 },
        results: [
          {
            id: 1, name: 'Onboarding', hypothesis: 'GitHub first', status: 'running', started_at: '2026-11-17T09:00:00Z', ended_at: null,
            feature: { id: 11, name: 'onboarding_flow', type: 'MULTIVARIATE', initial_value: 'control', multivariate_options: [{ id: 5, key: 'github_first', string_value: 'github_first', default_percentage_allocation: 50 }] },
            metrics: [{ id: 90, metric: 31, metric_name: 'Issue opened', aggregation: 'count', direction: 'increase', expected_direction: 'increase' }],
          },
          { id: 2, name: 'Draft one', status: 'created', feature: { id: 12, name: 'docs_cta', initial_value: null, multivariate_options: [] }, metrics: [] },
        ],
      },
      // ExperimentDetailSerializer: experiment_rollout.audience.segments
      'environments/env_key/experiments/1/': { id: 1, experiment_rollout: { enabled: true, rollout_percentage: 100, audience: { match: 'any', segments: [{ id: 51, name: 'First-time visitors', deleted: false }, { id: 59, name: 'Gone', deleted: true }] } } },
      'environments/env_key/experiment-metrics/31/': { id: 31, name: 'Issue opened', definition: { version: 1, event: 'issue_opened' } },
      'environments/env_key/': { id: 3, project: 7, api_key: 'env_key', name: 'Production' },
      'projects/7/segments/51/': { id: 51, name: 'First-time visitors', rules: [{ type: 'ALL', rules: [{ type: 'ANY', conditions: [{ property: 'visitor_type', operator: 'EQUAL', value: 'new' }] }], conditions: [] }] },
      'projects/7/segments/52/': { id: 52, name: 'EU', rules: [{ type: 'ALL', rules: [{ conditions: [{ property: 'country', operator: 'IN', value: 'DE,FR' }] }] }] },
      'features/feature-segments/?environment=3&feature=11': { results: [{ id: 900, segment: 52, segment_name: 'EU', is_system_segment: false }, { id: 901, segment: 77, segment_name: 'rollout', is_system_segment: true }] },
    };
    const get = async (path: string) => {
      calls.push(path);
      if (!(path in api)) throw new Error(`404 ${path}`);
      return api[path];
    };
    const exps = await readFromFlagsmith(get, { environment: 'env_key', apiUrl: 'https://api.flagsmith.com', log: () => {} });
    const [e, draft] = exps;
    assert.equal(e.flagKey, 'onboarding_flow');
    assert.deepEqual(e.variationKeys, ['github_first']);
    assert.deepEqual(e.metricEvents, ['issue_opened']);
    assert.equal(e.status, 'running');
    assert.equal(draft.status, 'draft');
    assert.deepEqual(e.audience?.map(a => [a.name, a.traits]), [['First-time visitors', ['visitor_type']], ['EU', ['country']]]);
    // project comes from the environment; no per-feature call is needed; system segments are skipped
    assert.ok(!calls.some(c => c.startsWith('projects/7/features/')));
    assert.ok(!calls.includes('projects/7/segments/77/'));
  });
});
