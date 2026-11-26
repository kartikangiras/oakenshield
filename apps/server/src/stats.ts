import { RULES, type LiveExperiment, type RuleId } from '@oakenshield/guard';
import type { ActivityItem, CheckRecord, DayPoint, ExperimentView, Overview, RuleView, Settings } from './api-types.ts';
import type { ExperimentService } from './experiments.ts';

const DAY = 86_400_000;

function within(checks: CheckRecord[], from: number, to: number) {
  return checks.filter(c => {
    const t = Date.parse(c.createdAt);
    return t >= from && t < to;
  });
}

/**
 * Pull requests blocked, counted once each. CI runs on every push, so one pull request can be
 * blocked several times; checks without a pull request (CLI, coding agents) count once per check.
 */
function blockedCount(checks: CheckRecord[], verdicts: Array<CheckRecord['verdict']> = ['block']): number {
  const keys = new Set<string>();
  for (const c of checks) if (verdicts.includes(c.verdict)) keys.add(c.pr ? `${c.repo}#${c.pr.number}` : c.id);
  return keys.size;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

export function activityFor(c: CheckRecord): ActivityItem[] {
  const where = c.pr ? `${c.repo}#${c.pr.number}` : `${c.repo} (${c.source === 'mcp' ? 'coding agent' : c.source})`;
  const exp = c.affected[0]?.name;
  const items: ActivityItem[] = [{
    id: `${c.id}-check`,
    at: c.createdAt,
    kind: 'check',
    verdict: c.override ? 'block' : c.verdict,
    repo: c.repo,
    checkId: c.id,
    title: c.verdict === 'pass'
      ? `Passed ${where}`
      : `${c.override || c.verdict === 'block' ? 'Blocked' : 'Warned on'} ${where}`,
    detail: c.pr?.title ? `${c.pr.title}${exp ? ` · ${exp}` : ''}` : exp ? `Touches ${exp}` : 'Local check before commit',
  }];
  if (c.override) {
    items.unshift({
      id: `${c.id}-override`,
      at: c.override.at,
      kind: 'override',
      verdict: 'overridden',
      repo: c.repo,
      checkId: c.id,
      title: `@${c.override.by} overrode ${where}`,
      detail: c.pr?.title ?? 'Override label applied',
    });
  }
  return items;
}

export function buildOverview(checks: CheckRecord[], exps: ExperimentService, settings: Settings, days = 30, now = Date.now()): Overview {
  // Whole UTC days: today plus the days-1 before it, compared with the same span before that.
  const today = new Date(now);
  const from = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (days - 1) * DAY;
  const cur = within(checks, from, now + 1);
  const prev = within(checks, from - days * DAY, from);
  const series: DayPoint[] = [];
  for (let d = 0; d < days; d++) {
    const date = new Date(from + d * DAY).toISOString().slice(0, 10);
    series.push({ date, pass: 0, warn: 0, block: 0, overridden: 0 });
  }
  const index = new Map(series.map(p => [p.date, p]));
  for (const c of cur) {
    const p = index.get(c.createdAt.slice(0, 10));
    if (p) p[c.verdict] += 1;
  }

  const ruleCounts = new Map<RuleId, number>();
  for (const c of cur) for (const f of c.findings) if (!f.ignoredBecause) ruleCounts.set(f.rule, (ruleCounts.get(f.rule) ?? 0) + 1);
  const byRule = RULES
    .map(r => {
      const s = settings.ruleSeverity[r.id];
      return { rule: r.id, title: r.title, severity: s && s !== 'off' ? s : r.defaultSeverity, count: ruleCounts.get(r.id) ?? 0 };
    })
    .filter(r => r.count > 0)
    .sort((a, b) => b.count - a.count);

  const repoMap = new Map<string, { repo: string; checks: number; blocks: number }>();
  for (const c of cur) {
    const r = repoMap.get(c.repo) ?? { repo: c.repo, checks: 0, blocks: 0 };
    r.checks++;
    repoMap.set(c.repo, r);
  }
  for (const r of repoMap.values()) r.blocks = blockedCount(cur.filter(c => c.repo === r.repo), ['block', 'overridden']);

  const blocks = blockedCount(cur);
  const protectedIds = new Set(cur.filter(c => c.verdict !== 'pass').flatMap(c => c.affected.map(a => String(a.id))));
  return {
    mode: exps.mode,
    rangeDays: days,
    kpis: {
      checks: cur.length,
      checksPrev: prev.length,
      blocks,
      blocksPrev: blockedCount(prev),
      warns: cur.filter(c => c.verdict === 'warn').length,
      overrides: cur.filter(c => c.verdict === 'overridden').length,
      passRate: cur.length ? cur.filter(c => c.verdict === 'pass').length / cur.length : 1,
      protectedExperiments: protectedIds.size,
      runningExperiments: exps.running.length,
      hoursSaved: blocks * settings.hoursPerBlock,
      medianDurationMs: median(cur.filter(c => c.source === 'ci').map(c => c.durationMs)),
    },
    series,
    byRule,
    byRepo: [...repoMap.values()].sort((a, b) => b.checks - a.checks),
    recent: checks.slice(0, 14).flatMap(activityFor).slice(0, 14),
  };
}

export function experimentView(exp: LiveExperiment, checks: CheckRecord[], service: ExperimentService, now = Date.now()): ExperimentView {
  const mine = checks.filter(c => c.affected.some(a => String(a.id) === String(exp.id)));
  const recent = mine.filter(c => Date.parse(c.createdAt) > now - 30 * DAY);
  const last = mine[0];
  return {
    ...exp,
    references: service.references(exp),
    checks: recent.length,
    blocks: blockedCount(recent, ['block', 'overridden']),
    warns: recent.filter(c => c.verdict === 'warn').length,
    lastCheck: last ? { id: last.id, at: last.createdAt, verdict: last.verdict, pr: last.pr } : undefined,
  };
}

export function ruleViews(checks: CheckRecord[], settings: Settings, now = Date.now()): RuleView[] {
  const recent = checks.filter(c => Date.parse(c.createdAt) > now - 30 * DAY);
  return RULES.map(r => ({
    id: r.id,
    title: r.title,
    category: r.category,
    defaultSeverity: r.defaultSeverity,
    severity: settings.ruleSeverity[r.id] ?? r.defaultSeverity,
    firesWhen: r.firesWhen,
    consequence: r.consequence,
    fix: r.fix,
    deterministic: r.deterministic,
    hits30d: recent.reduce((n, c) => n + c.findings.filter(f => f.rule === r.id && !f.ignoredBecause).length, 0),
  }));
}
