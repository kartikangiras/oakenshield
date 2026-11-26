import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { GuardConfig } from './config.ts';
import { demoSnapshot } from './demo.ts';
import type { ExperimentStatus, LiveExperiment, Snapshot } from './types.ts';

/*
 * Reads live experiments from Flagsmith.
 *
 * Verified in the Flagsmith docs (Nov 2026):
 *   POST environments/{env}/experiment-metrics/   (create metric)
 *   POST environments/{env}/experiments/          (create experiment)
 *   POST environments/{env}/experiments/{id}/start/
 *   GET  environments/{env}/experiments/{id}/results/
 * Assumed (check with `flagsmith api` or the MCP server's list tools):
 *   GET  environments/{env}/experiments/          (list)
 *   GET  environments/{env}/experiment-metrics/{id}/
 *   GET  projects/{project}/features/{id}/        (multivariate options + keys)
 * The mapping below is tolerant of field-name differences and logs what it skips.
 */

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface SnapshotOptions {
  config: GuardConfig;
  env?: NodeJS.ProcessEnv;
  file?: string;
  demo?: boolean;
  log?: (msg: string) => void;
}

export class SnapshotError extends Error {}

type Getter = (path: string) => Promise<Json>;

function httpGetter(apiUrl: string, apiKey: string): Getter {
  return async path => {
    // Accept the host (https://api.flagsmith.com) or the SDK-style URL Flagsmith's docs give for
    // self-hosting (http://localhost:8000/api/v1/).
    const root = apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    const url = `${root}/api/v1/${path.replace(/^\/+/, '')}`;
    const res = await fetch(url, {
      headers: { Authorization: `Api-Key ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new SnapshotError(`Flagsmith ${res.status} for GET ${url}`);
    return res.json();
  };
}

function cliGetter(apiUrl: string): Getter {
  return async path => {
    // The Flagsmith CLI's `api` command takes the path from the host root (`api/v1/...`) and
    // applies its own credentials, including OIDC in GitHub Actions (checked against flagsmith-cli).
    const args = ['api', `api/v1/${path.replace(/^\/+/, '')}`, '--json'];
    const root = apiUrl.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
    if (root && root !== 'https://api.flagsmith.com') args.push('--api-url', root);
    const out = execFileSync('flagsmith', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
    return JSON.parse(out);
  };
}

export function hasFlagsmithCli(): boolean {
  try {
    execFileSync('flagsmith', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function listAll(get: Getter, path: string): Promise<Json[]> {
  const items: Json[] = [];
  let page: Json = await get(path);
  for (let guard = 0; guard < 50; guard++) {
    if (Array.isArray(page)) return page;
    items.push(...(page?.results ?? []));
    if (!page?.next) break;
    const next = String(page.next).replace(/^https?:\/\/[^/]+\/api\/v1\//, '');
    page = await get(next);
  }
  return items;
}

export function normalizeStatus(raw: Json): ExperimentStatus {
  const s = String(raw?.status ?? raw?.state ?? '').toLowerCase();
  if (['running', 'started', 'active', 'live', 'in_progress'].includes(s)) return 'running';
  if (['ended', 'completed', 'finished', 'stopped', 'concluded'].includes(s)) return 'ended';
  if (s === 'paused') return 'paused';
  if (s === 'draft' || s === 'not_started' || s === 'created') return 'draft';
  if (raw?.ended_at || raw?.end_date) return 'ended';
  if (raw?.started_at || raw?.start_date) return 'running';
  return 'draft';
}

/*
 * Endpoints and fields below were checked against Flagsmith's API source (api/experimentation,
 * features, segments, environments):
 *  - GET environments/{key}/experiments/            paginated; feature is nested with
 *    {id, name, initial_value, multivariate_options[{id, key, string_value, …}]};
 *    metrics are [{metric: <id>, metric_name, expected_direction, …}]; status is
 *    created | running | paused | completed
 *  - GET environments/{key}/experiments/{id}/       adds experiment_rollout.audience.segments[{id, name, deleted}]
 *  - GET environments/{key}/experiment-metrics/{id}/ definition = {version: 1, event}
 *  - GET environments/{key}/                        {id, project, …}
 *  - GET projects/{id}/segments/{id}/               rules[{rules, conditions[{property, operator, value}]}]
 *  - GET features/feature-segments/?environment=&feature=   [{segment, segment_name, is_system_segment}]
 * Auth is "Authorization: Api-Key <organisation key>".
 */
export async function readFromFlagsmith(get: Getter, opts: { project?: string; environment: string; apiUrl: string; log: (m: string) => void }): Promise<LiveExperiment[]> {
  const raws = await listAll(get, `environments/${opts.environment}/experiments/`);
  let envInfo: Json = null;
  try { envInfo = await get(`environments/${opts.environment}/`); } catch (err) { opts.log(`Could not read environment ${opts.environment}: ${(err as Error).message}`); }
  const project = opts.project ?? (envInfo?.project !== undefined && envInfo?.project !== null ? String(typeof envInfo.project === 'object' ? envInfo.project.id : envInfo.project) : undefined);
  const out: LiveExperiment[] = [];
  const audienceIds = new Map<LiveExperiment, number[]>();
  const optionKeys = (options: Json[]) => options
    .map((o: Json) => o?.key ?? o?.variant_key ?? (typeof o?.string_value === 'string' && o.string_value ? o.string_value : null))
    .filter((k: string | null): k is string => !!k && k !== 'control');

  for (const raw of raws) {
    const status = normalizeStatus(raw);
    const nested = typeof raw.feature === 'object' && raw.feature ? raw.feature : null;
    const featureId = Number(nested ? nested.id : raw.feature ?? raw.feature_id);
    let flagKey: string = nested?.name ?? raw.feature_name ?? raw.flag_key ?? '';
    let controlValue: string | undefined = nested?.initial_value ?? undefined;
    let variationKeys: string[] = Array.isArray(nested?.multivariate_options) ? optionKeys(nested.multivariate_options) : [];
    if ((!nested || !flagKey) && featureId && project) {
      try {
        const feature = await get(`projects/${project}/features/${featureId}/`);
        flagKey = feature.name ?? flagKey;
        controlValue = feature.initial_value ?? controlValue;
        variationKeys = optionKeys(feature.multivariate_options ?? []);
      } catch (err) {
        opts.log(`Could not read feature ${featureId}: ${(err as Error).message}`);
      }
    }
    const metricEvents: string[] = [];
    for (const m of raw.metrics ?? []) {
      const metric = typeof m.metric === 'object' ? m.metric : m;
      const event = metric?.definition?.event;
      if (event) { metricEvents.push(event); continue; }
      const id = typeof m.metric === 'number' ? m.metric : metric?.id;
      if (!id) continue;
      try {
        const full = await get(`environments/${opts.environment}/experiment-metrics/${id}/`);
        if (full?.definition?.event) metricEvents.push(full.definition.event);
      } catch (err) {
        opts.log(`Could not read metric ${id}: ${(err as Error).message}`);
      }
    }
    if (!flagKey) { opts.log(`Skipping experiment ${raw.id}: no flag key`); continue; }
    const exp: LiveExperiment = {
      id: raw.id,
      name: raw.name ?? flagKey,
      environmentKey: opts.environment,
      flagKey,
      featureId: featureId || undefined,
      controlValue,
      variationKeys,
      metricEvents,
      status,
      startedAt: raw.started_at ?? raw.start_date ?? undefined,
      endsAt: raw.ended_at ?? raw.end_date ?? undefined,
      hypothesis: raw.hypothesis ?? undefined,
      dashboardUrl: project ? `${opts.apiUrl.replace(/\/api\/v1\/?$/, '').replace('://api.', '://app.')}/project/${project}/environment/${opts.environment}/experiments/${raw.id}` : undefined,
    };
    out.push(exp);
    // The experiment's own audience lives on its detail view, under experiment_rollout.
    const ids: number[] = [];
    if (status === 'running') {
      try {
        const detail = await get(`environments/${opts.environment}/experiments/${raw.id}/`);
        for (const sg of detail?.experiment_rollout?.audience?.segments ?? []) if (!sg?.deleted && Number(sg?.id)) ids.push(Number(sg.id));
      } catch (err) {
        opts.log(`Could not read experiment ${raw.id}: ${(err as Error).message}`);
      }
    }
    audienceIds.set(exp, ids);
  }
  await attachAudiences(get, out, audienceIds, { project, environmentId: envInfo?.id, log: opts.log });
  return out;
}

/** Trait keys used anywhere in a segment's rules. The Admin API calls them `property`; environment documents use `property_`. */
export function segmentTraits(segment: Json): string[] {
  const keys = new Set<string>();
  const walk = (rule: Json) => {
    for (const c of rule?.conditions ?? []) {
      const p = c?.property ?? c?.property_;
      if (typeof p === 'string' && p) keys.add(p);
    }
    for (const r of rule?.rules ?? []) walk(r);
  };
  for (const r of segment?.rules ?? []) walk(r);
  return [...keys];
}

/**
 * Works out which segments decide each running experiment's audience: the segment
 * overrides on its flag in this environment, plus any segment the experiment names.
 * Endpoints: projects/{id}/segments/, environments/{key}/ and features/feature-segments/.
 */
async function attachAudiences(get: Getter, exps: LiveExperiment[], named: Map<LiveExperiment, number[]>, opts: { project?: string; environmentId?: number; log: (m: string) => void }) {
  const running = exps.filter(e => e.status === 'running');
  if (running.length === 0 || !opts.project) return;
  const cache = new Map<number, Json | null>();
  const segment = async (id: number): Promise<Json | null> => {
    if (!cache.has(id)) {
      try { cache.set(id, await get(`projects/${opts.project}/segments/${id}/`)); } catch (err) {
        opts.log(`Could not read segment ${id}: ${(err as Error).message}`);
        cache.set(id, null);
      }
    }
    return cache.get(id) ?? null;
  };
  for (const e of running) {
    const ids = new Set(named.get(e) ?? []);
    // Other segment overrides on the flag also decide who reaches the experiment.
    // The experiment's own rollout segment is a system segment and is skipped.
    if (opts.environmentId && e.featureId) {
      try {
        for (const fs of await listAll(get, `features/feature-segments/?environment=${opts.environmentId}&feature=${e.featureId}`)) {
          if (fs?.is_system_segment) continue;
          const id = Number(typeof fs.segment === 'object' ? fs.segment?.id : fs.segment);
          if (id) ids.add(id);
        }
      } catch (err) {
        opts.log(`Could not read segment overrides for ${e.flagKey}: ${(err as Error).message}`);
      }
    }
    const audience = [];
    for (const id of ids) {
      const sg = await segment(id);
      if (!sg) continue;
      const traits = segmentTraits(sg);
      if (traits.length) audience.push({ id: sg.id ?? id, name: String(sg.name ?? `Segment ${id}`), traits });
    }
    if (audience.length > 0) e.audience = audience;
  }
}

/**
 * Resolution order: explicit file, demo, API key, Flagsmith CLI (OIDC in CI), configured snapshot file.
 */
export async function readSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => {});
  const { config } = opts;
  if (opts.file) return loadSnapshotFile(opts.file);
  if (opts.demo) return demoSnapshot();

  const environment = env.GUARD_FLAGSMITH_ENVIRONMENT || config.flagsmith.environment;
  const project = env.GUARD_FLAGSMITH_PROJECT || config.flagsmith.project;
  const apiUrl = env.FLAGSMITH_API_URL || config.flagsmith.apiUrl;
  if (environment) {
    if (env.FLAGSMITH_API_KEY && config.flagsmith.auth !== 'cli') {
      const experiments = await readFromFlagsmith(httpGetter(apiUrl, env.FLAGSMITH_API_KEY), { project, environment, apiUrl, log });
      return { fetchedAt: new Date().toISOString(), source: 'flagsmith-api', environmentKey: environment, experiments };
    }
    if (config.flagsmith.auth !== 'none' && hasFlagsmithCli()) {
      const experiments = await readFromFlagsmith(cliGetter(apiUrl), { project, environment, apiUrl, log });
      return { fetchedAt: new Date().toISOString(), source: 'flagsmith-cli', environmentKey: environment, experiments };
    }
  }
  if (config.flagsmith.snapshotFile && existsSync(config.flagsmith.snapshotFile)) return loadSnapshotFile(config.flagsmith.snapshotFile);
  throw new SnapshotError(
    environment
      ? 'No Flagsmith credentials: set FLAGSMITH_API_KEY, install the Flagsmith CLI, or pass --snapshot.'
      : 'No Flagsmith environment configured: set flagsmith.environment in .experiment-guard.yml, or pass --snapshot / --demo.',
  );
}

export function loadSnapshotFile(path: string): Snapshot {
  const data = JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
  if (!Array.isArray(data.experiments)) throw new SnapshotError(`${path} is not a snapshot (no experiments array)`);
  return { ...data, source: data.source ?? 'file' };
}
