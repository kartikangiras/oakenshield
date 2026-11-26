import type { GuardConfig } from './config.ts';
import { defaultConfig } from './config.ts';
import type { Finding, Report } from './types.ts';

export const COMMENT_MARKER = '<!-- experiment-guard -->';

const SEV_LABEL = { block: 'Blocking', warn: 'Warning', info: 'Info' } as const;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function headline(report: Report): string {
  const c = report.counts;
  if (report.verdict === 'overridden') return `Experiment Guard: overridden by @${report.override?.by ?? 'a maintainer'}`;
  if (c.block > 0) return `Experiment Guard: ${plural(c.block, 'blocking issue')}`;
  if (c.warn > 0) return `Experiment Guard: ${plural(c.warn, 'warning')}`;
  if (report.snapshot.running === 0) return 'Experiment Guard: no running experiments';
  return 'Experiment Guard: no running experiments affected';
}

function location(f: Finding): string {
  return `\`${f.file}:${f.line}\``;
}

function findingMarkdown(f: Finding): string {
  const lines: string[] = [];
  lines.push(`**${f.rule} · ${f.title}** — ${location(f)}${f.ignoredBecause ? ' _(ignored)_' : ''}`);
  lines.push('');
  lines.push('```diff');
  lines.push(f.evidence);
  lines.push('```');
  lines.push(`- ${f.consequence}`);
  if (f.hint) lines.push(`- ${f.hint}`);
  if (f.aiNote) lines.push(`- ${f.aiNote}`);
  if (f.suggestion) lines.push(`- A suggested change is posted on line ${f.suggestion.line}. Accept it to fix this.`);
  if (f.ignoredBecause) lines.push(`- Ignored in code: "${f.ignoredBecause}"`);
  return lines.join('\n');
}

/** The single PR comment Guard keeps up to date. */
export function renderMarkdown(report: Report, config: GuardConfig = defaultConfig(), state?: Record<string, unknown>): string {
  const out: string[] = [COMMENT_MARKER];
  out.push(`### ${headline(report)}`);
  out.push('');
  const affected = report.affectedExperiments;
  if (affected.length > 0) {
    const names = affected.map(e => `**${e.name}** (flag \`${e.flagKey}\`)`).join(', ');
    out.push(`This PR touches code that ${affected.length === 1 ? 'a running experiment depends on' : 'running experiments depend on'}: ${names}.`);
    out.push('');
  } else if (report.verdict === 'pass') {
    out.push(report.snapshot.running === 0
      ? 'There are no running experiments in this environment, so nothing to protect.'
      : `Checked against ${plural(report.snapshot.running, 'running experiment')}. Nothing in this PR touches their flags, events or variations.`);
    out.push('');
  }

  for (const sev of ['block', 'warn'] as const) {
    const items = report.findings.filter(f => f.severity === sev);
    if (items.length === 0) continue;
    out.push(`#### ${SEV_LABEL[sev]}`);
    out.push('');
    for (const f of items) { out.push(findingMarkdown(f)); out.push(''); }
  }

  if (report.verdict === 'block') {
    out.push('**Ways forward**');
    out.push('1. Accept the suggested changes, or fix the code by hand.');
    out.push('2. End the experiment in Flagsmith first, then merge.');
    out.push(`3. A maintainer adds the \`${config.override.label}\` label. It will be recorded here.`);
    out.push('');
  }

  if (report.override) {
    const o = report.override;
    out.push(o.accepted
      ? `> Override accepted: label \`${o.label}\` added by @${o.by} at ${o.at}.`
      : `> Override ignored: @${o.by} added \`${o.label}\` but ${o.reason ?? 'lacks the required permission'}.`);
    out.push('');
  }

  for (const note of report.notes ?? []) {
    out.push(`> **Note:** ${note}`);
    out.push('');
  }

  const infos = report.findings.filter(f => f.severity === 'info');
  if (infos.length > 0) {
    out.push(`<details><summary>${plural(infos.length, 'info finding')}</summary>`);
    out.push('');
    for (const f of infos) { out.push(findingMarkdown(f)); out.push(''); }
    out.push('</details>');
    out.push('');
  }

  const when = new Date(report.snapshot.fetchedAt).toISOString().replace('T', ' ').slice(0, 16);
  out.push(`<sub>Snapshot: ${plural(report.snapshot.running, 'running experiment')}, read ${when} UTC from ${report.snapshot.source}. ` +
    `Scanned ${plural(report.stats.filesScanned, 'file')} in ${report.durationMs} ms. Experiment Guard ${report.toolVersion}.</sub>`);
  if (state) out.push(`<!-- experiment-guard:state ${JSON.stringify(state)} -->`);
  return `${out.join('\n')}\n`;
}

export function readCommentState(body: string): Record<string, unknown> {
  const m = body.match(/<!-- experiment-guard:state (\{.*?\}) -->/);
  if (!m) return {};
  try { return JSON.parse(m[1]) as Record<string, unknown>; } catch { return {}; }
}

// ---- terminal output ----

const useColor = () => !process.env.NO_COLOR && (process.stdout.isTTY || !!process.env.FORCE_COLOR);
const paint = (code: string) => (s: string) => (useColor() ? `\u001b[${code}m${s}\u001b[0m` : s);
const red = paint('31');
const yellow = paint('33');
const cyan = paint('36');
const green = paint('32');
const dim = paint('2');
const bold = paint('1');

export function renderText(report: Report): string {
  const out: string[] = [];
  const v = report.verdict;
  const tag = v === 'block' ? red('BLOCK') : v === 'warn' ? yellow('WARN') : v === 'overridden' ? cyan('OVERRIDDEN') : green('PASS');
  out.push(`${bold(tag)}  ${headline(report)}`);
  out.push(dim(`${report.snapshot.running} running experiment(s) · ${report.stats.filesScanned} file(s) scanned · ${report.durationMs} ms`));
  for (const f of report.findings) {
    const sev = f.severity === 'block' ? red('block') : f.severity === 'warn' ? yellow('warn ') : cyan('info ');
    out.push('');
    out.push(`${sev} ${bold(f.rule)} ${f.title}${f.ignoredBecause ? dim(' (ignored)') : ''}`);
    out.push(`      ${dim(`${f.file}:${f.line}`)}${f.experimentName ? dim(`  ·  ${f.experimentName}`) : ''}`);
    for (const l of f.evidence.split('\n')) out.push(`      ${l.startsWith('-') ? red(l) : l.startsWith('+') ? green(l) : l}`);
    out.push(`      ${f.consequence}`);
    if (f.hint) out.push(`      ${dim(f.hint)}`);
    if (f.suggestion) out.push(`      ${cyan('fix:')} ${f.suggestion.replacement.trim()}`);
  }
  for (const note of report.notes ?? []) {
    out.push('');
    out.push(`${cyan('note ')} ${note.replaceAll('`', '')}`);
  }
  return `${out.join('\n')}\n`;
}
