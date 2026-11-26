import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadScenarioSet } from '@oakenshield/guard';
import type { CheckRecord } from '../src/api-types.ts';
import { ExperimentService } from '../src/experiments.ts';
import { buildOverview } from '../src/stats.ts';
import { DEFAULT_SETTINGS } from '../src/store.ts';

const scenarios = loadScenarioSet();

function check(id: string, pr: number | null, verdict: CheckRecord['verdict'], minutesAgo: number): CheckRecord {
  return {
    id, repo: 'acme/app', verdict, source: pr ? 'ci' : 'cli', durationMs: 50,
    createdAt: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    pr: pr ? { number: pr, title: `PR ${pr}` } : undefined,
    findings: [], affected: [], counts: { block: verdict === 'block' ? 1 : 0, warn: 0, info: 0 }, markdown: '', stats: { filesChanged: 1, additions: 1, deletions: 1 },
  } as unknown as CheckRecord;
}

describe('overview stats', () => {
  it('counts a pull request blocked on several pushes once', async () => {
    const experiments = new ExperimentService({ mode: 'demo', config: scenarios.config, demoFiles: scenarios.baseFiles });
    await experiments.refresh();
    const checks = [
      check('c1', 8, 'block', 30), check('c2', 8, 'block', 20), check('c3', 8, 'overridden', 10),
      check('c4', 9, 'block', 5), check('c5', null, 'block', 3), check('c6', null, 'block', 2), check('c7', 10, 'pass', 1),
    ];
    const o = buildOverview(checks, experiments, DEFAULT_SETTINGS);
    assert.equal(o.kpis.checks, 7);
    assert.equal(o.kpis.blocks, 4); // PR 8, PR 9 and two local checks
    assert.equal(o.kpis.hoursSaved, 4 * DEFAULT_SETTINGS.hoursPerBlock);
    assert.deepEqual(o.byRepo, [{ repo: 'acme/app', checks: 7, blocks: 4 }]);
  });
});
