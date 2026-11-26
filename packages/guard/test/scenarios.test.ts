import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { demoSnapshot } from '../src/demo.ts';
import { runCheck } from '../src/engine.ts';
import { loadScenarioSet, scenarioRepo } from '../src/scenarios.ts';

const set = loadScenarioSet();
const snapshot = demoSnapshot(new Date('2026-11-27T08:00:00Z'));

describe('seeded scenarios', () => {
  for (const s of set.scenarios.filter(x => !x.negative)) {
    it(`${s.id}: ${s.expect.verdict} via ${s.expect.rules.join(', ')}`, () => {
      const report = runCheck({ repo: scenarioRepo(set, s), snapshot, config: set.config });
      assert.equal(report.verdict, s.expect.verdict);
      const rules = [...new Set(report.findings.map(f => f.rule))].sort();
      assert.deepEqual(rules, [...s.expect.rules].sort());
    });
  }
});

describe('negative controls produce zero findings', () => {
  for (const s of set.scenarios.filter(x => x.negative)) {
    it(s.id, () => {
      const report = runCheck({ repo: scenarioRepo(set, s), snapshot, config: set.config });
      assert.equal(report.verdict, 'pass');
      assert.deepEqual(report.findings, []);
    });
  }
});

describe('suggestions', () => {
  const get = (id: string) => {
    const s = set.scenarios.find(x => x.id === id)!;
    return runCheck({ repo: scenarioRepo(set, s), snapshot, config: set.config });
  };
  it('EG001 suggests restoring the exact event name on the added line', () => {
    const f = get('rename-event').findings[0];
    assert.equal(f.suggestion?.file, 'app/components/MatchedIssues.tsx');
    assert.match(f.suggestion!.replacement, /trackEvent\('issue_opened'\)/);
    assert.match(f.consequence, /Other code still sends it/);
  });
  it('EG005 suggests the real variation key', () => {
    const f = get('variant-key-rename').findings[0];
    assert.match(f.suggestion!.replacement, /'github_first'/);
  });
  it('EG004 suggests the minimum SDK version', () => {
    const f = get('downgrade-sdk').findings[0];
    assert.match(f.suggestion!.replacement, /\^12\.4\.0/);
  });
  it('blocking findings name the affected experiment', () => {
    const r = get('remove-exposure');
    assert.deepEqual(r.affectedExperiments.map(e => e.flagKey), ['onboarding_flow']);
  });
});

describe('experiment status', () => {
  it('ignores experiments that are not running', () => {
    const s = set.scenarios.find(x => x.id === 'rename-event')!;
    const ended = { ...snapshot, experiments: snapshot.experiments.map(e => ({ ...e, status: 'ended' as const })) };
    const report = runCheck({ repo: scenarioRepo(set, s), snapshot: ended, config: set.config });
    assert.equal(report.verdict, 'pass');
    assert.equal(report.findings.length, 0);
  });
});
