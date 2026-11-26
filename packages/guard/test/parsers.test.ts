import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError, parseConfigText } from '../src/config.ts';
import { computeFileDiff, formatUnifiedDiff, parseUnifiedDiff } from '../src/diff.ts';
import { matchesAny } from '../src/glob.ts';
import { levenshtein, norm, renameKind, scanText } from '../src/scanner.ts';
import { parseYaml } from '../src/yaml.ts';

describe('yaml subset', () => {
  it('parses nested maps, lists, inline lists and scalars', () => {
    const doc = parseYaml([
      'version: 1  # comment',
      'flagsmith:',
      '  api_url: "https://api.flagsmith.com"',
      '  fail_open: false',
      'scan:',
      '  include: ["src/**", app/**]',
      '  exclude:',
      '    - docs/**',
      "    - '**/*.snap'",
      'items:',
      '  - name: a',
      '    weight: 50',
      '  - name: b',
      'empty:',
    ].join('\n'));
    assert.deepEqual(doc, {
      version: 1,
      flagsmith: { api_url: 'https://api.flagsmith.com', fail_open: false },
      scan: { include: ['src/**', 'app/**'], exclude: ['docs/**', '**/*.snap'] },
      items: [{ name: 'a', weight: 50 }, { name: 'b' }],
      empty: null,
    });
  });
  it('keeps # inside quotes', () => {
    assert.deepEqual(parseYaml('label: "a # b"'), { label: 'a # b' });
  });
});

describe('config', () => {
  it('maps snake_case keys and validates severities', () => {
    const { config, warnings } = parseConfigText('flagsmith:\n  environment: abc\nrules:\n  EG006: block\n  EG999: warn\noverride:\n  min_permission: admin\n');
    assert.equal(config.flagsmith.environment, 'abc');
    assert.equal(config.rules.EG006, 'block');
    assert.equal(config.override.minPermission, 'admin');
    assert.match(warnings.join(), /EG999/);
  });
  it('rejects bad values', () => {
    assert.throws(() => parseConfigText('rules:\n  EG001: loud\n'), ConfigError);
  });
});

describe('diffs', () => {
  it('parses git diffs with renames, new files and deletions', () => {
    const text = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 90%',
      'rename from old.ts',
      'rename to new.ts',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '-gone',
      '+came',
      'diff --git a/added.ts b/added.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/added.ts',
      '@@ -0,0 +1,1 @@',
      '+hello',
      'diff --git a/dead.ts b/dead.ts',
      'deleted file mode 100644',
      '--- a/dead.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
      '',
    ].join('\n');
    const files = parseUnifiedDiff(text);
    assert.deepEqual(files.map(f => [f.path, f.status]), [['new.ts', 'renamed'], ['added.ts', 'added'], ['dead.ts', 'deleted']]);
    assert.deepEqual(files[0].hunks[0].lines.map(l => [l.kind, l.oldLine ?? null, l.newLine ?? null]), [
      ['ctx', 1, 1], ['del', 2, null], ['add', null, 2],
    ]);
  });
  it('round-trips computed diffs through the parser', () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 5', 'line five').replace('line 25\n', '');
    const fd = computeFileDiff('f.txt', before, after)!;
    const parsed = parseUnifiedDiff(formatUnifiedDiff([fd]));
    assert.deepEqual(parsed[0].hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines]), fd.hunks.map(h => [h.oldStart, h.oldLines, h.newStart, h.newLines]));
    assert.equal(parsed[0].hunks.length, 2);
  });
});

describe('scanner', () => {
  it('finds exposures, conversions, variants and events', () => {
    const { hits } = scanText("const f = useExperiment('onb'); if (f.variant === 'b') trackEvent('done'); init({ enableEvents: true })", 'js');
    const kinds = hits.filter(h => h.kind !== 'literal').map(h => `${h.kind}:${h.value}`);
    assert.deepEqual(kinds, ['exposure:onb', 'conversion:done', 'variant:b', 'events:true']);
  });
  it('handles Python calls', () => {
    const { hits } = scanText('flag = fs.get_experiment_flag("onb", identifier=uid)\nif flag.variant == "b": fs.track_event("done", identifier=uid)', 'py');
    const kinds = hits.filter(h => ['exposure', 'conversion', 'variant'].includes(h.kind)).map(h => `${h.kind}:${h.value}`);
    assert.deepEqual(kinds, ['exposure:onb', 'conversion:done', 'variant:b']);
  });
  it('recognises renames', () => {
    assert.equal(norm('issue_opened'), norm('issueOpened'));
    assert.equal(levenshtein('kitten', 'sitting'), 3);
    assert.equal(renameKind('issue_opened', 'issueOpened'), 'style');
    assert.equal(renameKind('issue_opened', 'issue_open'), 'typo');
    assert.equal(renameKind('a', 'b'), null);
  });
});

describe('globs', () => {
  it('matches ** and braces', () => {
    assert.ok(matchesAny('src/a/b.test.ts', ['**/*.test.*']));
    assert.ok(matchesAny('docs/x.md', ['docs/**']));
    assert.ok(matchesAny('app/page.tsx', ['{app,src}/**']));
    assert.ok(!matchesAny('lib/x.ts', ['{app,src}/**']));
  });
});
