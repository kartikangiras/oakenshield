import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { explainWarnings } from './ai.ts';
import { loadConfig, type GuardConfig } from './config.ts';
import { exitCodeFor, runCheck } from './engine.ts';
import { readSnapshot, SnapshotError } from './flagsmith.ts';
import { applyOverride, loadGitHubContext, publish, resolveOverride, unenforcedNote, withNote, writeStepSummary } from './github.ts';
import { formatUnifiedDiff } from './diff.ts';
import { serveMcp } from './mcp.ts';
import { DiffOnlyRepoView, GitRepoView, type RepoView } from './repo.ts';
import { renderMarkdown, renderText } from './report.ts';
import { RULES, RULES_BY_ID } from './rules/catalog.ts';
import { loadScenarioSet, scenarioRepo } from './scenarios.ts';
import type { Report, RuleId, Snapshot } from './types.ts';
import { VERSION } from './version.ts';

const HELP = `experiment-guard ${VERSION}
Blocks pull requests that would silently corrupt a running Flagsmith experiment.

Usage
  experiment-guard check [options]      Check a diff against running experiments
  experiment-guard snapshot [--out f]   Read running experiments from Flagsmith
  experiment-guard demo [scenario]      Run a bundled scenario against the demo app
  experiment-guard rules                List the rules
  experiment-guard explain <EG001>      Explain one rule
  experiment-guard mcp                  Start the MCP server (stdio)

Check options
  --base <ref>          Base ref (default: origin/main, or the PR base in Actions)
  --head <ref>          Head ref, or WORKTREE for uncommitted changes (default: HEAD)
  --diff <file|->       Check a unified diff file (or stdin) instead of git refs
  --snapshot <file>     Use a saved snapshot instead of calling Flagsmith
  --demo                Use the built-in demo snapshot
  --config <file>       Config path (default: .experiment-guard.yml)
  --format <f>          text | json | markdown | github   (default: text)
  --fail-on <level>     block | warn | never              (default: block)
  --report-url <url>    Also POST the report to an Oakenshield dashboard
  --out <file>          Write the report to a file as well
  --cwd <dir>           Repository directory (default: current directory)
`;

function fail(msg: string, code = 2): never {
  process.stderr.write(`experiment-guard: ${msg}\n`);
  process.exit(code);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** GitHub workflow commands, so findings also show as annotations on the pull request's files. */
export function annotations(report: Report): string {
  const data = (v: string) => v.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  const prop = (v: string) => data(v).replace(/:/g, '%3A').replace(/,/g, '%2C');
  return report.findings
    .filter(f => !f.ignoredBecause && f.severity !== 'info')
    .map(f => {
      // A removed line has no place in the head version of the file, so it is annotated on the file.
      const where = f.side === 'removed' ? `file=${prop(f.file)}` : `file=${prop(f.file)},line=${f.line}`;
      const level = f.severity === 'block' && report.verdict !== 'overridden' ? 'error' : 'warning';
      return `::${level} ${where},title=${prop(`${f.rule} ${f.title}`)}::${data(f.consequence)}\n`;
    })
    .join('');
}

async function postReport(report: Report, url: string) {
  const target = `${url.replace(/\/+$/, '')}/api/reports`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.OAKENSHIELD_TOKEN) headers.authorization = `Bearer ${process.env.OAKENSHIELD_TOKEN}`;
  try {
    const res = await fetch(target, { method: 'POST', headers, body: JSON.stringify(report), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) process.stderr.write(`experiment-guard: dashboard returned ${res.status}\n`);
  } catch (err) {
    process.stderr.write(`experiment-guard: could not reach dashboard: ${(err as Error).message}\n`);
  }
}

async function getSnapshot(config: GuardConfig, values: { snapshot?: string; demo?: boolean }): Promise<Snapshot | null> {
  try {
    return await readSnapshot({ config, file: values.snapshot, demo: values.demo, log: m => process.stderr.write(`experiment-guard: ${m}\n`) });
  } catch (err) {
    if (err instanceof SnapshotError && config.flagsmith.failOpen) {
      process.stderr.write(`experiment-guard: warning: ${err.message} Passing because fail_open is on.\n`);
      return null;
    }
    throw err;
  }
}

function emptyReport(reason: string): Report {
  const now = new Date().toISOString();
  return {
    version: 1, tool: 'experiment-guard', toolVersion: VERSION, createdAt: now, durationMs: 0,
    snapshot: { fetchedAt: now, source: 'file', running: 0 },
    stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, filesScanned: 0 },
    findings: [], counts: { block: 0, warn: 0, info: 0, ignored: 0 }, verdict: 'pass', affectedExperiments: [],
    override: { by: 'experiment-guard', at: now, label: 'fail-open', accepted: false, reason },
  };
}

async function cmdCheck(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      base: { type: 'string' }, head: { type: 'string' }, diff: { type: 'string' },
      snapshot: { type: 'string' }, demo: { type: 'boolean' }, config: { type: 'string' },
      format: { type: 'string', default: 'text' }, 'fail-on': { type: 'string', default: 'block' },
      'report-url': { type: 'string' }, out: { type: 'string' }, cwd: { type: 'string' },
    },
  });
  const cwd = resolve(values.cwd ?? process.cwd());
  const { config, warnings } = loadConfig(cwd, values.config);
  for (const w of warnings) process.stderr.write(`experiment-guard: config: ${w}\n`);
  const gh = values.format === 'github' ? loadGitHubContext() : null;
  if (values.format === 'github' && !gh) fail('--format github needs GITHUB_TOKEN, GITHUB_REPOSITORY and a pull_request event');

  const snapshot = await getSnapshot(config, values);
  let report: Report;
  let checkedDiff: string | undefined;
  if (!snapshot) {
    report = emptyReport('Flagsmith could not be read');
  } else {
    let repo: RepoView;
    if (values.diff) {
      repo = new DiffOnlyRepoView(values.diff === '-' ? await readStdin() : readFileSync(values.diff, 'utf8'));
    } else {
      const envBase = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : 'origin/main';
      repo = new GitRepoView({ cwd, base: values.base ?? gh?.baseSha ?? envBase, head: values.head ?? gh?.headSha ?? 'HEAD' });
    }
    report = runCheck({
      repo,
      snapshot,
      config,
      meta: { repo: gh?.repo ?? process.env.GITHUB_REPOSITORY, base: values.base ?? gh?.baseSha, head: values.head ?? gh?.headSha, pr: gh ? { ...gh.pr, headSha: gh.headSha } : undefined, source: gh ? 'ci' : 'cli' },
    });
    // Kept for the dashboard, which re-checks open pull requests when experiments change in Flagsmith.
    try { checkedDiff = formatUnifiedDiff(repo.diff()); } catch { checkedDiff = undefined; }
    report = await explainWarnings(report, config);
  }

  if (gh) {
    report = applyOverride(report, await resolveOverride(report, gh, config));
    if (report.verdict === 'block') report = withNote(report, await unenforcedNote(gh));
    const { commentUrl, suggestions } = await publish(report, gh, config);
    writeStepSummary(renderMarkdown(report, config));
    process.stdout.write(`${renderText(report)}\nComment: ${commentUrl}${suggestions ? ` (${suggestions} new suggestion(s))` : ''}\n`);
    process.stdout.write(annotations(report));
  } else if (values.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else if (values.format === 'markdown') {
    process.stdout.write(renderMarkdown(report, config));
  } else {
    process.stdout.write(renderText(report));
  }

  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, JSON.stringify(report, null, 2));
  }
  const url = values['report-url'] ?? process.env.OAKENSHIELD_URL ?? config.report.url;
  if (url) await postReport(checkedDiff && checkedDiff.length <= 512 * 1024 ? { ...report, diff: checkedDiff } : report, url);
  process.exitCode = exitCodeFor(report, values['fail-on'] as 'block' | 'warn' | 'never');
}

async function cmdSnapshot(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { out: { type: 'string' }, demo: { type: 'boolean' }, config: { type: 'string' }, cwd: { type: 'string' } } });
  const cwd = resolve(values.cwd ?? process.cwd());
  const { config } = loadConfig(cwd, values.config);
  const snapshot = await readSnapshot({ config, demo: values.demo, log: m => process.stderr.write(`experiment-guard: ${m}\n`) });
  const json = JSON.stringify(snapshot, null, 2);
  if (values.out) {
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, `${json}\n`);
    process.stderr.write(`Wrote ${snapshot.experiments.length} experiment(s) to ${values.out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function cmdDemo(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { format: { type: 'string', default: 'text' } } });
  const set = loadScenarioSet();
  const { demoSnapshot } = await import('./demo.ts');
  const id = positionals[0];
  if (!id) {
    process.stdout.write('Scenarios (run one with `experiment-guard demo <id>`):\n');
    for (const s of set.scenarios) process.stdout.write(`  ${s.id.padEnd(26)} ${s.negative ? '(control) ' : ''}${s.title}\n`);
    return;
  }
  const scenario = set.scenarios.find(s => s.id === id) ?? fail(`unknown scenario "${id}"`);
  const report = runCheck({ repo: scenarioRepo(set, scenario), snapshot: demoSnapshot(), config: set.config, meta: { repo: 'oakenshield/firstpr', source: 'cli' } });
  process.stdout.write(values.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : values.format === 'markdown' ? renderMarkdown(report, set.config) : renderText(report));
}

function cmdRules() {
  for (const r of RULES) process.stdout.write(`${r.id}  ${r.defaultSeverity.padEnd(5)}  ${r.title}\n`);
}

function cmdExplain(argv: string[]) {
  const id = (argv[0] ?? '').toUpperCase() as RuleId;
  const r = RULES_BY_ID[id] ?? fail(`unknown rule "${argv[0] ?? ''}" (try: experiment-guard rules)`);
  process.stdout.write(`${r.id}  ${r.title}  [${r.defaultSeverity}]\n\nFires when:   ${r.firesWhen}\nConsequence:  ${r.consequence}\nFix:          ${r.fix}\n`);
}

async function cmdMcp(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { snapshot: { type: 'string' }, demo: { type: 'boolean' }, config: { type: 'string' }, cwd: { type: 'string' } } });
  const cwd = resolve(values.cwd ?? process.cwd());
  const { config } = loadConfig(cwd, values.config);
  await serveMcp({ cwd, config, snapshotFile: values.snapshot, demo: values.demo });
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case 'check': return await cmdCheck(rest);
      case 'snapshot': return await cmdSnapshot(rest);
      case 'demo': return await cmdDemo(rest);
      case 'rules': return cmdRules();
      case 'explain': return cmdExplain(rest);
      case 'mcp': return await cmdMcp(rest);
      case '--version': case '-v': process.stdout.write(`${VERSION}\n`); return;
      case undefined: case 'help': case '--help': case '-h': process.stdout.write(HELP); return;
      default: fail(`unknown command "${cmd}"\n\n${HELP}`);
    }
  } catch (err) {
    fail((err as Error).message);
  }
}

if (process.argv[1] && /[\\/]cli\.[tj]s$/.test(process.argv[1])) {
  await main();
}
