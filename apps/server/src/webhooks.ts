import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  COMMENT_MARKER, DiffOnlyRepoView, renderMarkdown, runCheck,
  type Finding, type GuardConfig, type LiveExperiment, type Report, type Snapshot,
} from '@oakenshield/guard';
import type { CheckRecord, FlagsmithAlert, StreamEvent } from './api-types.ts';
import type { ExperimentService } from './experiments.ts';
import type { Store } from './store.ts';

/*
 * Flagsmith webhooks (checked against Flagsmith's API source, api/webhooks and api/features/tasks.py):
 * environment webhooks send FLAG_UPDATED / FLAG_DELETED; organisation webhooks send those too, plus
 * AUDIT_LOG_CREATED. The body is { event_type, data }, and with a secret Flagsmith sends
 * X-Flagsmith-Signature = hex HMAC-SHA256 of the exact body. One flag change can therefore arrive up
 * to three times (environment FLAG_UPDATED, organisation FLAG_UPDATED, audit log); duplicates are
 * dropped below.
 *
 * On each event we refresh the snapshot, then:
 *  - alert when a running experiment's flag or audience segment changes underneath it;
 *  - re-check open pull requests when what is protected changes (an experiment starts or
 *    ends, or its metrics, variations or audience change), and update their PR comments.
 */

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'));
  const got = Buffer.from(header.trim().toLowerCase());
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface ParsedEvent {
  eventType: string;
  flagKey?: string;
  segmentName?: string;
  relatedType?: string;
  actor?: string;
  identity?: string;
  deleted: boolean;
  changes: string[];
  summary: string;
}

const fmt = (v: unknown) => (v === null || v === undefined || v === '' ? 'empty' : typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

function weights(state: Json): string | null {
  const mv = state?.multivariate_feature_state_values;
  if (!Array.isArray(mv) || mv.length === 0) return null;
  return mv
    .map((v: Json) => {
      const o = v?.multivariate_feature_option ?? {};
      const key = o.key ?? o.string_value ?? o.value ?? `option ${o.id ?? v?.id ?? '?'}`;
      return `${key} ${v?.percentage_allocation ?? '?'}%`;
    })
    .join(', ');
}

export function parseEvent(p: Json): ParsedEvent {
  const eventType = String(p?.event_type ?? (p?.log ? 'AUDIT_LOG_CREATED' : 'UNKNOWN'));
  const d = p?.data ?? p;
  if (eventType === 'FLAG_UPDATED' || eventType === 'FLAG_DELETED') {
    const n = d?.new_state ?? null;
    const o = d?.previous_state ?? null;
    const st = n ?? o;
    const flagKey: string | undefined = st?.feature?.name ?? undefined;
    const segmentName: string | undefined = st?.feature_segment?.segment?.name ?? st?.feature_segment?.segment_name ?? undefined;
    const identity: string | undefined = st?.identity_identifier ?? st?.identity?.identifier ?? undefined;
    const changes: string[] = [];
    if (!n) changes.push('deleted');
    else {
      if (!o) changes.push('created');
      if (o && o.enabled !== n.enabled) changes.push(n.enabled ? 'turned on' : 'turned off');
      if (o && JSON.stringify(o.feature_state_value) !== JSON.stringify(n.feature_state_value)) changes.push(`value ${fmt(o.feature_state_value)} → ${fmt(n.feature_state_value)}`);
      const wo = weights(o);
      const wn = weights(n);
      if (wn && wo !== wn) changes.push(wo ? `variation weights ${wo} → ${wn}` : `variation weights set to ${wn}`);
    }
    const scope = identity ? ` for identity ${identity}` : segmentName ? ` for segment "${segmentName}"` : '';
    return {
      eventType, flagKey, segmentName, identity, actor: d?.changed_by ?? undefined, deleted: !n,
      changes, summary: `${flagKey ?? 'A flag'} ${changes.join(', ') || 'updated'}${scope}`,
    };
  }
  if (eventType === 'AUDIT_LOG_CREATED') {
    const log = String(d?.log ?? '');
    const relatedType = String(d?.related_object_type ?? '');
    return {
      eventType, relatedType, actor: d?.author?.email ?? d?.author?.first_name ?? undefined,
      deleted: /deleted/i.test(log) && relatedType === 'FEATURE', changes: log ? [log] : [], summary: log || 'Audit log entry',
    };
  }
  return { eventType, deleted: false, changes: [], summary: `${eventType} received` };
}

/* ---------- re-checking open pull requests ---------- */

const OPEN_DAYS = 14;
const findingKey = (f: Finding) => `${f.rule}|${f.file}|${f.line}|${f.side}|${f.experimentId ?? ''}`;

/** The latest CI result per pull request in the last two weeks, if we have its diff. */
export function openPullRequests(store: Store, now = Date.now()): CheckRecord[] {
  const latest = new Map<string, CheckRecord>();
  for (const c of store.checks) {
    if (!c.pr?.number || (c.source !== 'ci' && c.source !== 'webhook')) continue;
    if (Date.parse(c.createdAt) < now - OPEN_DAYS * 86_400_000) continue;
    const key = `${c.repo}#${c.pr.number}`;
    const prev = latest.get(key);
    if (!prev || prev.createdAt < c.createdAt) latest.set(key, c);
  }
  return [...latest.values()].filter(c => !!c.diff && c.verdict !== 'overridden');
}

function tally(findings: Finding[]) {
  const live = findings.filter(f => !f.ignoredBecause);
  const counts = {
    block: live.filter(f => f.severity === 'block').length,
    warn: live.filter(f => f.severity === 'warn').length,
    info: live.filter(f => f.severity === 'info').length,
    ignored: findings.length - live.length,
  };
  const verdict: CheckRecord['verdict'] = counts.block ? 'block' : counts.warn ? 'warn' : 'pass';
  return { counts, verdict };
}

/**
 * Re-runs one stored pull request against the old and new snapshots. Diff-only runs see less
 * than the original CI run did, so we apply only the difference between the two runs to the
 * stored result instead of replacing it.
 */
export function recheckRecord(rec: CheckRecord, before: Snapshot, after: Snapshot, config: GuardConfig, reason: string, newId: (p: string) => string): CheckRecord | null {
  if (!rec.diff) return null;
  const repo = new DiffOnlyRepoView(rec.diff);
  const meta = { repo: rec.repo, pr: rec.pr, source: 'webhook' as const };
  const b = runCheck({ repo, snapshot: before, config, meta });
  const a = runCheck({ repo, snapshot: after, config, meta });
  const bk = new Set(b.findings.map(findingKey));
  const ak = new Set(a.findings.map(findingKey));
  const added = a.findings.filter(f => !bk.has(findingKey(f)));
  const gone = new Set(b.findings.filter(f => !ak.has(findingKey(f))).map(findingKey));
  const stillRunning = new Set(after.experiments.filter(e => e.status === 'running').map(e => String(e.id)));
  const kept = rec.findings.filter(f => !gone.has(findingKey(f)) && (f.experimentId === undefined || f.experimentId === null || stillRunning.has(String(f.experimentId))));
  if (added.length === 0 && kept.length === rec.findings.length) return null;

  const findings = [...kept, ...added];
  const { counts, verdict } = tally(findings);
  const affected = new Map<string, Report['affectedExperiments'][number]>();
  for (const x of [...rec.affected, ...a.affectedExperiments]) if (stillRunning.has(String(x.id)) && findings.some(f => String(f.experimentId) === String(x.id))) affected.set(String(x.id), x);
  const report: Report = {
    ...a, createdAt: new Date().toISOString(), repo: rec.repo, pr: rec.pr, source: 'webhook',
    findings, counts, verdict, affectedExperiments: [...affected.values()], stats: rec.stats,
  };
  const md = renderMarkdown(report, config).split('\n');
  const at = md.findIndex(l => l.startsWith('### '));
  md.splice(at + 1, 0, '', `> Re-checked after a change in Flagsmith: ${reason}.`);
  return {
    id: newId('c'), repo: rec.repo, pr: rec.pr, source: 'webhook', createdAt: report.createdAt, durationMs: a.durationMs,
    verdict, counts, stats: rec.stats, affected: report.affectedExperiments, findings, markdown: md.join('\n'), diff: rec.diff,
  };
}

/* ---------- GitHub ---------- */

export interface GitHubPoster {
  isOpen(repo: string, n: number): Promise<boolean>;
  update(rec: CheckRecord): Promise<void>;
}

/** Upserts the Experiment Guard comment and sets a commit status, with a token that can write to the repo. */
export function gitHubPoster(token: string, apiUrl = 'https://api.github.com'): GitHubPoster {
  const call = async (method: string, path: string, body?: unknown): Promise<Json> => {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'oakenshield', 'x-github-api-version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${method} ${path}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    async isOpen(repo, n) {
      try { return (await call('GET', `/repos/${repo}/pulls/${n}`))?.state === 'open'; } catch { return true; }
    },
    async update(rec) {
      const n = rec.pr!.number;
      const comments: Json[] = await call('GET', `/repos/${rec.repo}/issues/${n}/comments?per_page=100`);
      const mine = comments.find(c => typeof c?.body === 'string' && c.body.includes(COMMENT_MARKER));
      if (mine) await call('PATCH', `/repos/${rec.repo}/issues/comments/${mine.id}`, { body: rec.markdown });
      else await call('POST', `/repos/${rec.repo}/issues/${n}/comments`, { body: rec.markdown });
      if (rec.pr?.headSha) {
        await call('POST', `/repos/${rec.repo}/statuses/${rec.pr.headSha}`, {
          state: rec.verdict === 'block' ? 'failure' : 'success',
          context: 'Experiment Guard (Flagsmith)',
          description: rec.verdict === 'block' ? `${rec.counts.block} blocking issue(s) after a Flagsmith change` : rec.verdict === 'warn' ? `${rec.counts.warn} warning(s) after a Flagsmith change` : 'No running experiment affected',
        });
      }
    },
  };
}

/* ---------- the handler ---------- */

const seen = new Map<string, number>();
/** True if an identical event was handled in the last ten minutes. */
function duplicate(ev: ParsedEvent, payload: Json): boolean {
  const d = payload?.data ?? {};
  const key = JSON.stringify([ev.eventType, ev.flagKey, ev.segmentName, ev.identity, ev.summary, d.timestamp ?? d.created_date ?? null]);
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > 600_000) seen.delete(k);
  if (seen.has(key)) return true;
  seen.set(key, now);
  return false;
}

export interface WebhookDeps {
  store: Store;
  experiments: ExperimentService;
  config: () => GuardConfig;
  addCheck: (c: CheckRecord) => CheckRecord;
  broadcast: (e: StreamEvent) => void;
  newId: (p: string) => string;
  github?: GitHubPoster;
  log?: (m: string) => void;
}

const definition = (e: LiveExperiment) => JSON.stringify([e.flagKey, [...e.variationKeys].sort(), [...e.metricEvents].sort(), (e.audience ?? []).map(a => [a.name, [...a.traits].sort()])]);

export interface HandleResult {
  duplicate?: boolean;
  event: ParsedEvent;
  alerts: FlagsmithAlert[];
  rechecked: number;
  changed: CheckRecord[];
}

export async function handleFlagsmithEvent(deps: WebhookDeps, payload: Json, origin: FlagsmithAlert['origin']): Promise<HandleResult> {
  const ev = parseEvent(payload);
  if (duplicate(ev, payload)) return { event: ev, alerts: [], rechecked: 0, changed: [], duplicate: true };
  const before = deps.experiments.snapshot;
  await deps.experiments.refresh();
  const after = deps.experiments.snapshot;

  const runningBefore = (before?.experiments ?? []).filter(e => e.status === 'running');
  const runningAfter = (after?.experiments ?? []).filter(e => e.status === 'running');
  const find = (list: LiveExperiment[], id: number | string) => list.find(e => String(e.id) === String(id));
  const started = runningAfter.filter(e => !find(runningBefore, e.id));
  const ended = runningBefore.filter(e => !find(runningAfter, e.id));
  const redefined = runningAfter.filter(e => { const b = find(runningBefore, e.id); return !!b && definition(b) !== definition(e); });

  const now = new Date().toISOString();
  const alerts: FlagsmithAlert[] = [];
  const mk = (a: Omit<FlagsmithAlert, 'id' | 'at' | 'origin' | 'eventType'>): FlagsmithAlert => ({ id: deps.newId('a'), at: now, origin, eventType: ev.eventType, ...a });
  const by = ev.actor ? ` by ${ev.actor}` : '';

  for (const e of started) {
    alerts.push(mk({
      kind: 'experiment-started', severity: 'info', experimentId: e.id, experimentName: e.name, flagKey: e.flagKey, actor: ev.actor,
      title: `"${e.name}" started`,
      detail: `Experiment Guard now protects ${e.flagKey}${e.metricEvents.length ? ` and the ${e.metricEvents.join(', ')} event${e.metricEvents.length > 1 ? 's' : ''}` : ''}. Open pull requests were re-checked.`,
    }));
  }
  for (const e of ended) {
    alerts.push(mk({
      kind: 'experiment-ended', severity: 'info', experimentId: e.id, experimentName: e.name, flagKey: e.flagKey, actor: ev.actor,
      title: `"${e.name}" ended`, detail: `Changes to its code are no longer blocked. Open pull requests were re-checked.`,
    }));
  }

  // Changes underneath experiments that were already running (not the change that started one).
  // Audit log entries about flags repeat what FLAG_UPDATED already said, so only segment
  // entries raise alerts from the audit log.
  const auditAboutFlags = ev.eventType === 'AUDIT_LOG_CREATED' && ev.relatedType !== 'SEGMENT';
  for (const e of runningBefore) {
    if (ended.includes(e) || ev.identity || auditAboutFlags) continue;
    const flagHit = ev.flagKey ? ev.flagKey === e.flagKey : ev.summary.includes(e.flagKey);
    if (flagHit) {
      alerts.push(mk({
        kind: ev.deleted ? 'flag-deleted' : 'config-change', severity: ev.deleted ? 'block' : 'warn',
        experimentId: e.id, experimentName: e.name, flagKey: e.flagKey, actor: ev.actor,
        title: ev.deleted ? `${e.flagKey} was deleted while "${e.name}" is running` : `${e.flagKey} changed while "${e.name}" is running`,
        detail: ev.deleted
          ? `The experiment's flag is gone${by}. Every user now gets the default, and the experiment stops collecting data.`
          : `${ev.changes.join('; ') || ev.summary}${ev.segmentName ? ` (segment "${ev.segmentName}")` : ''}${by}. Results now mix two configurations; consider restarting the experiment.`,
      }));
      continue;
    }
    const seg = (e.audience ?? []).find(a => a.name === ev.segmentName || (ev.relatedType === 'SEGMENT' && ev.summary.includes(a.name)));
    if (seg) {
      alerts.push(mk({
        kind: 'segment-change', severity: 'warn', experimentId: e.id, experimentName: e.name, flagKey: e.flagKey, actor: ev.actor,
        title: `Segment "${seg.name}" changed while "${e.name}" is running`,
        detail: `${ev.summary}${by}. This segment decides who can enter the experiment, so its audience shifts mid-run.`,
      }));
    }
  }

  let changed: CheckRecord[] = [];
  let rechecked = 0;
  if (before && after && (started.length || ended.length || redefined.length)) {
    const reason = [
      ...started.map(e => `"${e.name}" started`),
      ...ended.map(e => `"${e.name}" ended`),
      ...redefined.map(e => `"${e.name}" changed`),
    ].join(', ');
    const config = deps.config();
    for (const rec of openPullRequests(deps.store)) {
      if (deps.github && !(await deps.github.isOpen(rec.repo, rec.pr!.number))) continue;
      rechecked++;
      const next = recheckRecord(rec, before, after, config, reason, deps.newId);
      if (!next || (next.verdict === rec.verdict && next.findings.length === rec.findings.length)) continue;
      changed.push(deps.addCheck(next));
      if (deps.github) {
        try { await deps.github.update(next); } catch (err) { deps.log?.(`GitHub update failed for ${next.repo}#${next.pr?.number}: ${(err as Error).message}`); }
      }
    }
    const worse = changed.filter(c => c.verdict === 'block');
    const first = started[0] ?? ended[0] ?? redefined[0];
    alerts.push(mk({
      // A pull request that now passes is good news, so it only raises the alert's severity when it got worse.
      kind: 'recheck', severity: worse.length ? 'block' : changed.some(c => c.verdict === 'warn') ? 'warn' : 'info',
      experimentId: first?.id, experimentName: first?.name, flagKey: first?.flagKey, checkIds: changed.map(c => c.id),
      title: changed.length ? `${changed.length} open pull request${changed.length === 1 ? '' : 's'} changed verdict` : `Re-checked ${rechecked} open pull request${rechecked === 1 ? '' : 's'}: nothing changed`,
      detail: changed.length
        ? `${changed.map(c => `${c.repo}#${c.pr?.number} is now ${c.verdict === 'block' ? 'blocked' : c.verdict === 'warn' ? 'warned' : 'passing'}`).join('; ')}. Reason: ${reason}.`
        : `Reason: ${reason}. None of them touch what changed.`,
    }));
  }

  for (const a of alerts) {
    deps.store.addAlert(a);
    deps.broadcast({ type: 'alert', alert: a });
  }
  return { event: ev, alerts, rechecked, changed };
}

/* ---------- demo: realistic payloads for the simulate buttons ---------- */

export type SimulateKind = 'start-experiment' | 'change-weights' | 'edit-segment' | 'reset';

export function simulatedPayload(kind: Exclude<SimulateKind, 'reset'>): Json {
  const actor = 'kim@acme.dev';
  const timestamp = new Date().toISOString();
  const state = (flag: string, id: number, enabled: boolean, mv: Array<[number, string, number]>) => ({
    feature: {
      id, created_date: '2026-10-01T09:00:00.000000Z', default_enabled: false, description: null, initial_value: 'control', name: flag,
      project: { id: 7, name: 'FirstPR' }, type: 'MULTIVARIATE',
    },
    environment: { id: 3, name: 'Production' },
    identity: null, identity_identifier: null, feature_segment: null, enabled, feature_state_value: 'control',
    multivariate_feature_state_values: mv.map(([optId, value, pct], i) => ({ id: 100 + i, multivariate_feature_option: { id: optId, value }, percentage_allocation: pct })),
  });
  if (kind === 'start-experiment') {
    return { event_type: 'FLAG_UPDATED', data: { changed_by: actor, timestamp, previous_state: state('docs_cta', 9005, false, [[61, 'sticky', 0]]), new_state: state('docs_cta', 9005, true, [[61, 'sticky', 50]]) } };
  }
  if (kind === 'change-weights') {
    return { event_type: 'FLAG_UPDATED', data: { changed_by: actor, timestamp, previous_state: state('onboarding_flow', 9001, true, [[51, 'github_first', 50]]), new_state: state('onboarding_flow', 9001, true, [[51, 'github_first', 70]]) } };
  }
  return {
    event_type: 'AUDIT_LOG_CREATED',
    data: {
      id: Math.floor(Math.random() * 1e6), created_date: timestamp, log: 'Segment updated: First-time visitors',
      author: { id: 4, email: actor, first_name: 'Kim', last_name: 'Lee' }, organisation: { id: 1, name: 'Acme' }, environment: null,
      project: { id: 7, name: 'FirstPR' }, related_object_id: 7001, related_object_uuid: null, related_object_type: 'SEGMENT', is_system_event: false,
    },
  };
}
