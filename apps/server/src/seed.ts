import { createHash } from 'node:crypto';
import {
  DiffOnlyRepoView, formatUnifiedDiff, renderMarkdown, runCheck, RULES_BY_ID, scenarioRepo,
  type Finding, type GuardConfig, type LiveExperiment, type Report, type RuleId, type ScenarioSet, type Snapshot,
} from '@oakenshield/guard';
import type { CheckRecord } from './api-types.ts';

/*
 * Demo data: 30 days of checks across three repos. FirstPR checks are real
 * engine runs of the bundled scenarios; the other repos use templated findings.
 */

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newId(prefix: string): string {
  return `${prefix}_${createHash('sha1').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 10)}`;
}

interface Template {
  rule: RuleId;
  flagKey: string;
  file: string;
  line: number;
  side: Finding['side'];
  before?: string;
  after?: string;
  consequence: string;
  hint?: string;
  title: string;
}

const COMMUNITY: Template[] = [
  {
    rule: 'EG001', flagKey: 'mentor_match', file: 'src/mentors/MentorCard.tsx', line: 48, side: 'added',
    before: "flagsmith.trackEvent('mentor_requested');", after: "flagsmith.trackEvent('mentorRequested');",
    consequence: "This call site stops sending 'mentor_requested'. Other code still sends it, so only users who reach this path stop counting. If this path belongs to one arm, that arm will look like it is losing.",
    hint: "Renamed to 'mentorRequested'. Flagsmith matches event names exactly, so 'mentorRequested' counts toward nothing.",
    title: 'refactor(mentors): unify analytics naming',
  },
  {
    rule: 'EG005', flagKey: 'mentor_match', file: 'src/mentors/MentorPage.tsx', line: 31, side: 'added',
    before: "if (flag?.variant === 'match_quiz') return <MatchQuiz mentors={mentors} />;",
    after: "if (flag?.variant === 'matchQuiz') return <MatchQuiz mentors={mentors} />;",
    consequence: "The flag still serves 'match_quiz', but this code now checks for 'matchQuiz'. Users bucketed into 'match_quiz' see control code while being counted in 'match_quiz'.",
    title: 'style(mentors): camelCase identifiers',
  },
  {
    rule: 'EG002', flagKey: 'search_ranking', file: 'src/search/rank.ts', line: 22, side: 'removed',
    before: "const flag = await flagsmith.getExperimentFlag('search_ranking', userId);",
    consequence: "Nothing evaluates 'search_ranking' as an experiment any more. No new users enter \"Search ranking v2\", so its results stop growing.",
    title: 'refactor(search): read ranking mode from config',
  },
  {
    rule: 'EG004', flagKey: 'search_ranking', file: 'package.json', line: 19, side: 'added',
    before: '"@flagsmith/nodejs": "^9.1.2",', after: '"@flagsmith/nodejs": "^8.4.0",',
    consequence: '@flagsmith/nodejs ^8.4.0 is older than 9.1.0, the first version that sends experiment events. Exposures and conversions from this code stop.',
    title: 'build: roll back node SDK after cold-start regression',
  },
  {
    rule: 'EG006', flagKey: 'search_ranking', file: 'src/search/HybridResults.tsx', line: 17, side: 'added',
    after: '<ResultList results={results.slice(0, 8)} dense />',
    consequence: '<HybridResults> is rendered from the \'hybrid\' branch of "Search ranking v2" (src/search/Results.tsx:12). Changing it mid-run mixes two versions of that arm.',
    title: 'feat(search): denser hybrid results',
  },
  {
    rule: 'EG008', flagKey: 'mentor_match', file: 'src/app/root.tsx', line: 12, side: 'added',
    before: "src/mentors/MentorPage.tsx:14  const flag = useExperiment('mentor_match');",
    after: "src/app/root.tsx:12  const mentorFlag = useExperiment('mentor_match');",
    consequence: "The exposure for 'mentor_match' now fires in src/app/root.tsx, which runs for nearly every visitor. People who never see the change get counted as exposed, diluting the effect.",
    title: 'perf: prefetch flags in the root layout',
  },
  {
    rule: 'EG007', flagKey: 'search_ranking', file: 'src/lib/identity.ts', line: 9, side: 'removed',
    before: 'flagsmith.identify(session.userId);', after: 'flagsmith.identify(session.email);',
    consequence: 'This touches how users are identified. If the identifier changes for a returning user, their exposure and conversions stop matching, and anyone seen in two arms is quarantined.',
    title: 'chore(auth): identify by email',
  },
];

const PASS_TITLES: Record<string, string[]> = {
  'oakenshield/community': [
    'fix(feed): duplicate posts after refresh', 'feat(profile): pinned repositories', 'chore: upgrade vite', 'perf(search): cache facets',
    'fix(mentors): tooltip overflow on mobile', 'feat(profile): contribution history export', 'test: onboarding e2e flake', 'docs: community runbook',
    'refactor(feed): extract useFeed hook', 'fix(search): empty-state copy',
  ],
  'oakenshield/docs-site': [
    'docs: experimentation quickstart', 'fix: broken anchor links', 'feat: dark mode code blocks', 'docs: SDK version table',
    'chore: bump docusaurus', 'docs: MCP server guide',
  ],
};

const AUTHORS = ['priya', 'sam', 'maya', 'lee', 'arjun', 'nina', 'coding-agent', 'renovate'];

function summarizeReport(findings: Finding[]): Pick<Report, 'counts' | 'verdict' | 'affectedExperiments'> {
  const active = findings.filter(f => !f.ignoredBecause);
  const counts = {
    block: active.filter(f => f.severity === 'block').length,
    warn: active.filter(f => f.severity === 'warn').length,
    info: active.filter(f => f.severity === 'info').length,
    ignored: findings.length - active.length,
  };
  const affected = new Map<string, { id: number | string; name: string; flagKey: string }>();
  for (const f of active) if (f.experimentId !== null) affected.set(String(f.experimentId), { id: f.experimentId, name: f.experimentName ?? '', flagKey: f.flagKey ?? '' });
  return { counts, verdict: counts.block ? 'block' : counts.warn ? 'warn' : 'pass', affectedExperiments: [...affected.values()] };
}

function templateFinding(t: Template, exp: LiveExperiment | undefined): Finding {
  const meta = RULES_BY_ID[t.rule];
  const evidence = [t.before ? `- ${t.before}` : '', t.after ? `+ ${t.after}` : ''].filter(Boolean).join('\n');
  const f: Finding = {
    id: createHash('sha1').update(`${t.rule}${t.file}${t.line}`).digest('hex').slice(0, 12),
    rule: t.rule, severity: meta.defaultSeverity, title: meta.title,
    experimentId: exp?.id ?? null, experimentName: exp?.name ?? null, flagKey: exp?.flagKey ?? null,
    file: t.file, line: t.line, side: t.side, evidence, consequence: t.consequence,
  };
  if (t.hint) f.hint = t.hint;
  if (t.before && t.after && (t.rule === 'EG001' || t.rule === 'EG005' || t.rule === 'EG004')) {
    f.suggestion = { file: t.file, line: t.line, original: t.after, replacement: t.before };
  }
  return f;
}

function templateDiff(t: Template): string {
  const lines = [`diff --git a/${t.file} b/${t.file}`, `--- a/${t.file}`, `+++ b/${t.file}`];
  const strip = (s: string) => s.replace(/^\S+:\d+\s+/, '');
  const old = t.before && t.rule !== 'EG008' ? [`-  ${t.before}`] : [];
  const neu = t.after ? [`+  ${strip(t.after)}`] : [];
  lines.push(`@@ -${t.line},${old.length} +${t.line},${neu.length} @@`, ...old, ...neu);
  return `${lines.join('\n')}\n`;
}

export function generateDemoChecks(opts: { set: ScenarioSet; snapshot: Snapshot; config: GuardConfig; now?: Date; days?: number }): CheckRecord[] {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 60;
  const rand = rng(20261126);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const byFlag = new Map(opts.snapshot.experiments.map(e => [e.flagKey, e]));

  // Real engine runs of every FirstPR scenario, reused as check templates.
  const runs = opts.set.scenarios.map(s => {
    const repo = scenarioRepo(opts.set, s);
    const report = runCheck({ repo, snapshot: opts.snapshot, config: opts.config, meta: { repo: 'oakenshield/firstpr' } });
    return { s, report, diff: formatUnifiedDiff(repo.diff()) };
  });
  const firstprBy = (v: 'block' | 'warn' | 'pass') => runs.filter(r => r.report.verdict === v);

  const prNo: Record<string, number> = { 'oakenshield/firstpr': 41, 'oakenshield/community': 1180, 'oakenshield/docs-site': 302 };
  const out: CheckRecord[] = [];

  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now.getTime() - d * 86_400_000);
    const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
    const n = Math.round((weekend ? 2 : 6) + rand() * (weekend ? 2 : 5) + (d < 7 ? 2 : 0));
    for (let i = 0; i < n; i++) {
      const hour = 4 + Math.floor(rand() * 13); // 09:30-22:30 IST in UTC
      const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, Math.floor(rand() * 60), Math.floor(rand() * 60)));
      if (at > now) continue;
      const roll = rand();
      const repo = roll < 0.45 ? 'oakenshield/firstpr' : roll < 0.85 ? 'oakenshield/community' : 'oakenshield/docs-site';
      const v = rand();
      const verdict: 'block' | 'warn' | 'pass' = repo === 'oakenshield/docs-site' ? 'pass' : v < 0.1 ? 'block' : v < 0.25 ? 'warn' : 'pass';
      const author = pick(AUTHORS);
      const viaAgent = author === 'coding-agent' && rand() < 0.6;
      const source = viaAgent ? 'mcp' : rand() < 0.08 ? 'cli' : 'ci';
      let findings: Finding[] = [];
      let title: string;
      let diff: string | undefined;
      let scenarioId: string | undefined;
      let stats = { filesChanged: 1 + Math.floor(rand() * 9), linesAdded: Math.floor(rand() * 180), linesRemoved: Math.floor(rand() * 90), filesScanned: 0 };

      if (repo === 'oakenshield/firstpr') {
        const pool = firstprBy(verdict);
        const r = pick(pool.length ? pool : firstprBy('pass'));
        findings = r.report.findings;
        title = r.s.prTitle ?? r.s.title;
        diff = r.diff;
        scenarioId = r.s.id;
        stats = r.report.stats;
      } else if (verdict === 'pass') {
        title = pick(PASS_TITLES[repo]);
      } else {
        const t = pick(COMMUNITY.filter(x => RULES_BY_ID[x.rule].defaultSeverity === verdict));
        findings = [templateFinding(t, byFlag.get(t.flagKey))];
        title = t.title;
        diff = templateDiff(t);
      }
      stats.filesScanned = Math.max(stats.filesScanned, Math.min(stats.filesChanged, 1 + Math.floor(rand() * stats.filesChanged)));

      const summary = summarizeReport(findings);
      const pr = source === 'mcp' ? undefined : { number: ++prNo[repo], title, author, branch: `${author}/${title.split(':').pop()!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`, url: `https://github.com/${repo}/pull/${prNo[repo]}` };
      let finalVerdict: CheckRecord['verdict'] = summary.verdict;
      let override: CheckRecord['override'];
      if (summary.verdict === 'block' && rand() < 0.22 && pr) {
        override = { by: pick(['priya', 'arjun']), at: new Date(at.getTime() + 20 * 60_000).toISOString(), label: opts.config.override.label, accepted: true };
        finalVerdict = 'overridden';
      }
      const report: Report = {
        version: 1, tool: 'experiment-guard', toolVersion: '0.1.0', createdAt: at.toISOString(),
        durationMs: source === 'ci' ? 300 + Math.floor(rand() * 1500) : 40 + Math.floor(rand() * 200),
        repo, pr, source, snapshot: { fetchedAt: at.toISOString(), source: 'demo', running: 3 },
        stats, findings, ...summary, verdict: finalVerdict, override,
      };
      out.push({
        id: `c_${createHash('sha1').update(`${repo}-${at.toISOString()}-${i}`).digest('hex').slice(0, 10)}`,
        repo, pr, source, createdAt: report.createdAt, durationMs: report.durationMs,
        verdict: finalVerdict, counts: summary.counts, stats, affected: summary.affectedExperiments,
        findings, override, scenarioId, diff,
        markdown: renderMarkdown(report, opts.config),
      });
    }
  }
  out.push(...openDocsPullRequests(opts, now));
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/*
 * Open docs-site pull requests that touch the draft "Sticky docs sign-up CTA". They pass today.
 * When that experiment starts in Flagsmith (or the demo's "start" button is pressed), the
 * webhook re-check flips the first two to blocked.
 */
const DOCS_OPEN = [
  { title: 'refactor(docs): consistent analytics event names', author: 'nina', file: 'src/components/SignupCta.tsx', line: 21, hoursAgo: 2,
    before: "    onClick={() => flagsmith.trackEvent('signup_started')}", after: "    onClick={() => flagsmith.trackEvent('signupStarted')}" },
  { title: 'feat(docs): rename the sticky CTA variant', author: 'arjun', file: 'src/theme/DocSidebar.tsx', line: 34, hoursAgo: 5,
    before: "  if (flag?.variant === 'sticky') return <StickyCta />;", after: "  if (flag?.variant === 'sidebar') return <StickyCta />;" },
  { title: 'docs: fix typos in the quickstart', author: 'priya', file: 'docs/quickstart.md', line: 12, hoursAgo: 9,
    before: 'Instal the SDK with npm and wrap your app in the provider.', after: 'Install the SDK with npm and wrap your app in the provider.' },
];

function openDocsPullRequests(opts: { snapshot: Snapshot; config: GuardConfig }, now: Date): CheckRecord[] {
  return DOCS_OPEN.map((p, i) => {
    const diff = [`diff --git a/${p.file} b/${p.file}`, `--- a/${p.file}`, `+++ b/${p.file}`, `@@ -${p.line},1 +${p.line},1 @@`, `-${p.before}`, `+${p.after}`, ''].join('\n');
    const number = 420 + i;
    const at = new Date(now.getTime() - p.hoursAgo * 3_600_000).toISOString();
    const pr = {
      number, title: p.title, author: p.author, branch: `${p.author}/${p.title.split(':').pop()!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)}`,
      url: `https://github.com/oakenshield/docs-site/pull/${number}`, headSha: createHash('sha1').update(p.title).digest('hex'),
    };
    const report = runCheck({ repo: new DiffOnlyRepoView(diff), snapshot: opts.snapshot, config: opts.config, meta: { repo: 'oakenshield/docs-site', pr, source: 'ci' } });
    return {
      id: `c_docs_${number}`, repo: 'oakenshield/docs-site', pr, source: 'ci' as const, createdAt: at, durationMs: 420 + i * 130,
      verdict: report.verdict, counts: report.counts, stats: report.stats, affected: report.affectedExperiments,
      findings: report.findings, diff, markdown: renderMarkdown({ ...report, createdAt: at }, opts.config),
    };
  });
}
