import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { GuardConfig } from './config.ts';
import { COMMENT_MARKER, readCommentState, renderMarkdown } from './report.ts';
import type { OverrideInfo, PullRequestInfo, Report } from './types.ts';

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface GitHubContext {
  token: string;
  apiUrl: string;
  repo: string;           // owner/name
  pr: PullRequestInfo;
  labels: string[];
  baseSha?: string;
  headSha?: string;
}

/** Reads the pull_request event GitHub Actions provides. */
export function loadGitHubContext(env: NodeJS.ProcessEnv = process.env): GitHubContext | null {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!token || !repo || !eventPath || !existsSync(eventPath)) return null;
  const event = JSON.parse(readFileSync(eventPath, 'utf8')) as Json;
  const pr = event.pull_request;
  if (!pr) return null;
  return {
    token,
    apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    repo,
    pr: { number: pr.number, title: pr.title, author: pr.user?.login, branch: pr.head?.ref, url: pr.html_url },
    labels: (pr.labels ?? []).map((l: Json) => l.name),
    baseSha: pr.base?.sha,
    headSha: pr.head?.sha,
  };
}

async function gh(ctx: GitHubContext, method: string, path: string, body?: unknown): Promise<Json> {
  const res = await fetch(`${ctx.apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ctx.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const RANK = { read: 0, triage: 1, write: 2, maintain: 3, admin: 4 } as const;

/** Applies the override label if the person who added it has enough permission. */
export async function resolveOverride(report: Report, ctx: GitHubContext, config: GuardConfig): Promise<OverrideInfo | undefined> {
  if (report.verdict !== 'block' || !ctx.labels.includes(config.override.label)) return undefined;
  const events: Json[] = await gh(ctx, 'GET', `/repos/${ctx.repo}/issues/${ctx.pr.number}/events?per_page=100`);
  const labeled = events.filter(e => e.event === 'labeled' && e.label?.name === config.override.label).pop();
  if (!labeled) return undefined;
  const by: string = labeled.actor?.login ?? 'unknown';
  const perm = await gh(ctx, 'GET', `/repos/${ctx.repo}/collaborators/${encodeURIComponent(by)}/permission`);
  const role = (perm.role_name ?? perm.permission ?? 'read') as keyof typeof RANK;
  const accepted = (RANK[role] ?? 0) >= RANK[config.override.minPermission];
  return {
    by,
    at: labeled.created_at,
    label: config.override.label,
    accepted,
    reason: accepted ? undefined : `their role is ${role}, and ${config.override.minPermission} or higher is required`,
  };
}

export function applyOverride(report: Report, override: OverrideInfo | undefined): Report {
  if (!override) return report;
  return { ...report, override, verdict: override.accepted ? 'overridden' : report.verdict };
}

/** Upserts Guard's comment and posts suggested changes it has not posted before. */
export async function publish(report: Report, ctx: GitHubContext, config: GuardConfig): Promise<{ commentUrl: string; suggestions: number }> {
  const comments: Json[] = await gh(ctx, 'GET', `/repos/${ctx.repo}/issues/${ctx.pr.number}/comments?per_page=100`);
  const existing = comments.find(c => typeof c.body === 'string' && c.body.startsWith(COMMENT_MARKER));
  const state = existing ? readCommentState(existing.body) : {};
  const already = new Set<string>(Array.isArray(state.suggested) ? (state.suggested as string[]) : []);

  const fresh = report.findings.filter(f => f.suggestion && !f.ignoredBecause && !already.has(f.id));
  if (fresh.length > 0 && ctx.headSha) {
    await gh(ctx, 'POST', `/repos/${ctx.repo}/pulls/${ctx.pr.number}/reviews`, {
      commit_id: ctx.headSha,
      event: 'COMMENT',
      body: `Experiment Guard suggests ${fresh.length} fix${fresh.length === 1 ? '' : 'es'} to keep running experiments intact.`,
      comments: fresh.map(f => ({
        path: f.suggestion!.file,
        line: f.suggestion!.line,
        side: 'RIGHT',
        body: `**${f.rule} · ${f.title}**\n${f.consequence}\n\n\`\`\`suggestion\n${f.suggestion!.replacement}\n\`\`\``,
      })),
    });
    for (const f of fresh) already.add(f.id);
  }

  const body = renderMarkdown(report, config, { suggested: [...already] });
  const comment = existing
    ? await gh(ctx, 'PATCH', `/repos/${ctx.repo}/issues/comments/${existing.id}`, { body })
    : await gh(ctx, 'POST', `/repos/${ctx.repo}/issues/${ctx.pr.number}/comments`, { body });
  return { commentUrl: comment.html_url, suggestions: fresh.length };
}

export function writeStepSummary(markdown: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
}
