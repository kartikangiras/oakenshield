import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { demoSnapshot } from '../src/demo.ts';
import { runCheck } from '../src/engine.ts';
import { handleMcpRequest } from '../src/mcp.ts';
import { GitRepoView } from '../src/repo.ts';
import { loadScenarioSet } from '../src/scenarios.ts';

const set = loadScenarioSet();
const snapshot = demoSnapshot(new Date('2026-11-27T08:00:00Z'));

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
}

function demoRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  git(dir, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(set.baseFiles)) {
    execFileSync('mkdir', ['-p', join(dir, path, '..')]);
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

describe('git integration', () => {
  it('checks a real branch with GitRepoView', () => {
    const dir = demoRepo();
    git(dir, 'checkout', '-q', '-b', 'rename');
    const file = join(dir, 'app/components/MatchedIssues.tsx');
    writeFileSync(file, readFileSync(file, 'utf8').replace("'issue_opened'", "'issueOpened'"));
    git(dir, 'commit', '-qam', 'rename event');
    const report = runCheck({ repo: new GitRepoView({ cwd: dir, base: 'main', head: 'rename' }), snapshot, config: set.config });
    assert.equal(report.verdict, 'block');
    assert.equal(report.findings[0].rule, 'EG001');
    assert.match(report.findings[0].consequence, /Other code still sends it/);
  });

  it('checks uncommitted changes with head=WORKTREE', () => {
    const dir = demoRepo();
    const file = join(dir, 'app/Landing.tsx');
    writeFileSync(file, readFileSync(file, 'utf8').replace("=== 'github_first'", "=== 'githubFirst'"));
    const report = runCheck({ repo: new GitRepoView({ cwd: dir, base: 'HEAD', head: 'WORKTREE' }), snapshot, config: set.config });
    assert.equal(report.findings[0]?.rule, 'EG005');
  });
});

describe('MCP server', () => {
  const opts = { cwd: process.cwd(), config: set.config, demo: true };
  it('initializes and lists tools', async () => {
    const cache = {};
    const init = await handleMcpRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, opts, cache);
    assert.equal(init.result.protocolVersion, '2025-06-18');
    const list = await handleMcpRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, opts, cache);
    assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name), ['list_protected_experiments', 'check_experiment_impact', 'explain_rule']);
    assert.equal(await handleMcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, opts, cache), null);
  });
  it('checks a diff through the tool call', async () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-trackEvent('github_connected')\n+trackEvent('githubConnected')\n";
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'check_experiment_impact', arguments: { diff } } }, opts, {});
    const report = JSON.parse(res.result.content[0].text);
    assert.equal(report.verdict, 'block');
  });
  it('explains rules', async () => {
    const res = await handleMcpRequest({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'explain_rule', arguments: { rule: 'eg003' } } }, opts, {});
    assert.match(res.result.content[0].text, /Events switched off/);
  });
});
