import { createHash } from 'node:crypto';
import type { GuardConfig } from './config.ts';
import { defaultConfig, inScope } from './config.ts';
import { addedLines, removedLines } from './diff.ts';
import type { RepoView } from './repo.ts';
import { RULE_IMPLS, RULES, RULES_BY_ID } from './rules/index.ts';
import { buildContext, type RawFinding, type RuleContext } from './rules/context.ts';
import { hasHit, scanLine } from './scanner.ts';
import type { FileDiff, Finding, PullRequestInfo, Report, RuleId, ScannedLine, Severity, Snapshot, Verdict } from './types.ts';
import { VERSION } from './version.ts';

const SEVERITY_RANK: Record<Severity, number> = { block: 3, warn: 2, info: 1 };

export { inScope };

export function effectiveSeverity(rule: RuleId, config: GuardConfig): Severity | 'off' {
  return config.rules[rule] ?? RULES_BY_ID[rule].defaultSeverity;
}

function findingId(f: RawFinding): string {
  return createHash('sha1')
    .update([f.rule, f.experiment?.id ?? '', f.file, f.line, f.side, f.evidence].join('|'))
    .digest('hex')
    .slice(0, 12);
}

const IGNORE_RE = /experiment-guard-ignore\s+(EG\d{3}|all)\b(?:\s*:\s*(.+?))?\s*(?:\*\/|-->)?\s*$/;

/** Honours `experiment-guard-ignore EG006: reason` on the finding's line or the line above it. */
function ignoreReason(f: RawFinding, repo: RepoView): { reason?: string; missing?: boolean } {
  if (f.side === 'removed') return {};
  const content = repo.read('head', f.file);
  if (!content) return {};
  const lines = content.split('\n');
  for (const idx of [f.line - 1, f.line - 2]) {
    const m = lines[idx]?.match(IGNORE_RE);
    if (!m || (m[1] !== 'all' && m[1] !== f.rule)) continue;
    if (!m[2]) return { missing: true };
    return { reason: m[2].trim() };
  }
  return {};
}

export interface CheckInput {
  repo: RepoView;
  snapshot: Snapshot;
  config?: GuardConfig;
  meta?: { repo?: string; base?: string; head?: string; pr?: PullRequestInfo; source?: Report['source'] };
  /** Restrict to these rules (used by tests). */
  only?: RuleId[];
}

export function runCheck(input: CheckInput): Report {
  const started = performance.now();
  const config = input.config ?? defaultConfig();
  const running = input.snapshot.experiments.filter(e => e.status === 'running');
  const allFiles = input.repo.diff();
  const files: FileDiff[] = allFiles.filter(f => !f.binary && inScope(f.path, config));

  const added: ScannedLine[] = [];
  const removed: ScannedLine[] = [];
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const f of allFiles) {
    const a = addedLines(f);
    const r = removedLines(f);
    linesAdded += a.length;
    linesRemoved += r.length;
    if (!files.includes(f)) continue;
    if (f.newPath) for (const l of a) added.push(scanLine(f.newPath, l.line, l.text, 'added', config.calls));
    if (f.oldPath) for (const l of r) removed.push(scanLine(f.oldPath, l.line, l.text, 'removed', config.calls));
  }

  const ctx = buildContext({ config, running, files, added, removed, repo: input.repo });
  const raw: Array<RawFinding & { severity: Severity }> = [];
  for (const meta of RULES) {
    if (input.only && !input.only.includes(meta.id)) continue;
    const sev = effectiveSeverity(meta.id, config);
    if (sev === 'off') continue;
    for (const f of RULE_IMPLS[meta.id](ctx)) raw.push({ ...f, severity: sev });
  }

  // De-duplicate: keep the most severe finding per file, line and side.
  const bySpot = new Map<string, RawFinding & { severity: Severity }>();
  for (const f of raw) {
    const key = `${f.file}:${f.line}:${f.side}`;
    const prev = bySpot.get(key);
    if (!prev || SEVERITY_RANK[f.severity] > SEVERITY_RANK[prev.severity]) bySpot.set(key, f);
    else if (prev.rule !== f.rule && SEVERITY_RANK[f.severity] === SEVERITY_RANK[prev.severity]) bySpot.set(`${key}:${f.rule}`, f);
  }

  const findings: Finding[] = [...bySpot.values()].map(f => {
    const meta = RULES_BY_ID[f.rule];
    const ign = ignoreReason(f, input.repo);
    const finding: Finding = {
      id: findingId(f),
      rule: f.rule,
      severity: f.severity,
      title: meta.title,
      experimentId: f.experiment?.id ?? null,
      experimentName: f.experiment?.name ?? null,
      flagKey: f.experiment?.flagKey ?? null,
      file: f.file,
      line: f.line,
      side: f.side,
      evidence: f.evidence,
      consequence: f.consequence,
    };
    if (f.hint) finding.hint = f.hint;
    if (f.suggestion && f.suggestion.replacement !== f.suggestion.original) finding.suggestion = f.suggestion;
    if (ign.reason) finding.ignoredBecause = ign.reason;
    if (ign.missing) finding.hint = `${finding.hint ? `${finding.hint} ` : ''}An ignore comment was found but has no reason, so it was not honoured.`;
    return finding;
  });

  findings.sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.rule.localeCompare(b.rule) || a.file.localeCompare(b.file) || a.line - b.line);

  const active = findings.filter(f => !f.ignoredBecause);
  const counts = {
    block: active.filter(f => f.severity === 'block').length,
    warn: active.filter(f => f.severity === 'warn').length,
    info: active.filter(f => f.severity === 'info').length,
    ignored: findings.length - active.length,
  };
  const verdict: Verdict = counts.block > 0 ? 'block' : counts.warn > 0 ? 'warn' : 'pass';

  const affected = new Map<string, { id: number | string; name: string; flagKey: string }>();
  for (const f of active) {
    if (f.experimentId === null) continue;
    affected.set(String(f.experimentId), { id: f.experimentId, name: f.experimentName ?? '', flagKey: f.flagKey ?? '' });
  }

  const notes = coverageNotes(ctx);

  return {
    version: 1,
    tool: 'experiment-guard',
    toolVersion: VERSION,
    createdAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    repo: input.meta?.repo,
    base: input.meta?.base,
    head: input.meta?.head,
    pr: input.meta?.pr,
    source: input.meta?.source,
    snapshot: { fetchedAt: input.snapshot.fetchedAt, source: input.snapshot.source, running: running.length },
    stats: { filesChanged: allFiles.length, linesAdded, linesRemoved, filesScanned: files.length },
    findings,
    counts,
    verdict,
    affectedExperiments: [...affected.values()],
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/**
 * Says where Guard is blind: a running experiment's flag or event is named in the code, but never
 * inside a call Guard recognises, which is what a project's own wrapper around the SDK looks like.
 * A key that appears nowhere belongs to another codebase and gets no note.
 */
export function coverageNotes(ctx: RuleContext): string[] {
  if (ctx.repo.kind === 'diff-only') return []; // only the pasted lines are visible, so nothing can be concluded
  const unread: Record<'exposure' | 'conversion', Array<{ key: string; at: string }>> = { exposure: [], conversion: [] };
  const look = (kind: 'exposure' | 'conversion', key: string) => {
    if (unread[kind].some(u => u.key === key)) return;
    const named = ctx.headLines(key).filter(l => l.lang !== 'other' && l.literals.has(key));
    if (named.length === 0 || named.some(l => hasHit(l, kind, key))) return;
    // The base code had a call Guard could read, so this pull request removed it: a finding, not a blind spot.
    if (ctx.baseLines(key).some(l => hasHit(l, kind, key))) return;
    unread[kind].push({ key, at: `${named[0].file}:${named[0].line}` });
  };
  for (const exp of ctx.running) {
    look('exposure', exp.flagKey);
    for (const event of exp.metricEvents) look('conversion', event);
  }
  const list = (items: Array<{ key: string; at: string }>) => items.map(u => `\`${u.key}\` (${u.at})`).join(', ');
  const notes: string[] = [];
  if (unread.exposure.length > 0) {
    notes.push(`Guard cannot see where ${list(unread.exposure)} ${unread.exposure.length === 1 ? 'is' : 'are'} evaluated: the code names ${unread.exposure.length === 1 ? 'the flag' : 'these flags'}, but not inside a call Guard recognises. ` +
      'If your code wraps the SDK, list the wrapper under `calls.exposure` in `.experiment-guard.yml`. Until then, removing or moving that call (EG002, EG008) goes unnoticed.');
  }
  if (unread.conversion.length > 0) {
    notes.push(`Guard cannot see the call that sends ${list(unread.conversion)}: the code names ${unread.conversion.length === 1 ? 'the event' : 'these events'}, but not inside a call Guard recognises. ` +
      'If your code wraps the SDK, list the wrapper under `calls.conversion` in `.experiment-guard.yml`. Removing or renaming the event is still caught (EG001); a new call with a name that almost matches (EG009) is not.');
  }
  return notes;
}

/** Exit code policy shared by the CLI and the Action. */
export function exitCodeFor(report: Report, failOn: 'block' | 'warn' | 'never' = 'block'): number {
  if (failOn === 'never' || report.verdict === 'overridden') return 0;
  if (report.verdict === 'block') return 1;
  if (failOn === 'warn' && report.verdict === 'warn') return 1;
  return 0;
}
