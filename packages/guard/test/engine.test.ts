import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultConfig, parseConfigText } from '../src/config.ts';
import { demoSnapshot } from '../src/demo.ts';
import { exitCodeFor, runCheck } from '../src/engine.ts';
import { DiffOnlyRepoView, MemoryRepoView } from '../src/repo.ts';
import { renderMarkdown, COMMENT_MARKER, readCommentState } from '../src/report.ts';

const snapshot = demoSnapshot(new Date('2026-11-27T08:00:00Z'));
const base = {
  'src/Card.tsx': "export const open = () => {\n  flagsmith.trackEvent('issue_opened');\n};\n",
};

describe('engine', () => {
  it('honours ignore comments that give a reason', () => {
    const head = {
      'src/Card.tsx': base['src/Card.tsx'],
      'src/New.tsx': "// experiment-guard-ignore EG009: legacy analytics name, tracked separately\nflagsmith.trackEvent('Issue_Opened');\n",
    };
    const report = runCheck({ repo: new MemoryRepoView(base, head), snapshot });
    const f = report.findings.find(x => x.rule === 'EG009')!;
    assert.equal(f.ignoredBecause, 'legacy analytics name, tracked separately');
    assert.equal(report.counts.ignored, 1);
  });

  it('does not honour an ignore comment without a reason', () => {
    const head = { ...base, 'src/New.tsx': "// experiment-guard-ignore EG009\nflagsmith.trackEvent('Issue_Opened');\n" };
    const report = runCheck({ repo: new MemoryRepoView(base, head), snapshot });
    const f = report.findings.find(x => x.rule === 'EG009')!;
    assert.equal(f.ignoredBecause, undefined);
    assert.match(f.hint ?? '', /no reason/);
  });

  it('can switch rules off and change severity', () => {
    const head = { 'src/Card.tsx': base['src/Card.tsx'].replace("'issue_opened'", "'issueOpened'") };
    const { config } = parseConfigText('rules:\n  EG001: warn\n');
    const report = runCheck({ repo: new MemoryRepoView(base, head), snapshot, config });
    assert.equal(report.verdict, 'warn');
    const off = parseConfigText('rules:\n  EG001: off\n  EG009: off\n').config;
    assert.equal(runCheck({ repo: new MemoryRepoView(base, head), snapshot, config: off }).verdict, 'pass');
  });

  it('excludes test files by default', () => {
    const b = { 'src/__tests__/Card.test.tsx': "trackEvent('issue_opened')\n" };
    const h = { 'src/__tests__/Card.test.tsx': "trackEvent('issueOpened')\n" };
    assert.equal(runCheck({ repo: new MemoryRepoView(b, h), snapshot }).verdict, 'pass');
  });

  it('does not count a README that names an event as code that still sends it', () => {
    const b = { ...base, 'README.md': 'The goal metric is `issue_opened`.\n' };
    const h = { ...b, 'src/Card.tsx': base['src/Card.tsx'].replace("'issue_opened'", "'issueOpened'") };
    const f = runCheck({ repo: new MemoryRepoView(b, h), snapshot }).findings.find(x => x.rule === 'EG001')!;
    assert.match(f.consequence, /Nothing in the codebase sends 'issue_opened'/);
  });

  it('works on a pasted diff with no repository', () => {
    const diff = [
      'diff --git a/src/Card.tsx b/src/Card.tsx',
      '--- a/src/Card.tsx',
      '+++ b/src/Card.tsx',
      '@@ -1,3 +1,3 @@',
      ' export const open = () => {',
      "-  flagsmith.trackEvent('issue_opened');",
      "+  flagsmith.trackEvent('issueOpened');",
      ' };',
      '',
    ].join('\n');
    const report = runCheck({ repo: new DiffOnlyRepoView(diff), snapshot });
    assert.equal(report.verdict, 'block');
    assert.equal(report.findings[0].rule, 'EG001');
    assert.equal(report.findings[0].suggestion?.line, 2);
  });

  it('maps verdicts to exit codes', () => {
    const head = { 'src/Card.tsx': base['src/Card.tsx'].replace("'issue_opened'", "'issueOpened'") };
    const report = runCheck({ repo: new MemoryRepoView(base, head), snapshot, config: defaultConfig() });
    assert.equal(exitCodeFor(report), 1);
    assert.equal(exitCodeFor(report, 'never'), 0);
    assert.equal(exitCodeFor({ ...report, verdict: 'overridden' }), 0);
  });

  it('renders one PR comment with a marker and hidden state', () => {
    const head = { 'src/Card.tsx': base['src/Card.tsx'].replace("'issue_opened'", "'issueOpened'") };
    const report = runCheck({ repo: new MemoryRepoView(base, head), snapshot });
    const md = renderMarkdown(report, defaultConfig(), { suggested: ['abc'] });
    assert.ok(md.startsWith(COMMENT_MARKER));
    assert.match(md, /1 blocking issue/);
    assert.match(md, /Ways forward/);
    assert.deepEqual(readCommentState(md), { suggested: ['abc'] });
  });
});
