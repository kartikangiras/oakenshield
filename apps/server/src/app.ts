import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import {
  DiffOnlyRepoView, formatUnifiedDiff, renderMarkdown, runCheck, RULE_IDS, scenarioRepo, VERSION,
  type GuardConfig, type Report, type RuleId, type ScenarioSet,
} from '@oakenshield/guard';
import type { CheckRecord, ClientConfig, FlagsmithAlert, Health, ScenarioView, Settings, StreamEvent } from './api-types.ts';
import { Arena } from './arena.ts';
import { readDuel } from './duel.ts';
import type { ExperimentService } from './experiments.ts';
import { newId } from './seed.ts';
import { activityFor, buildOverview, experimentView, ruleViews } from './stats.ts';
import { summarize, type Store } from './store.ts';
import { handleFlagsmithEvent, simulatedPayload, verifySignature, type GitHubPoster, type SimulateKind } from './webhooks.ts';

export interface AppOptions {
  store: Store;
  experiments: ExperimentService;
  scenarios: ScenarioSet;
  baseConfig: GuardConfig;
  dashboardDir?: string;
  ingestToken?: string;
  startedAt?: string;
  /** Secret configured on the Flagsmith webhooks; when set, unsigned deliveries are rejected. */
  webhookSecret?: string;
  /** Writes re-check results back to pull requests. */
  github?: GitHubPoster;
  /** Public settings for the dashboard, including the Flagsmith environment of its own A/B test. */
  client?: ClientConfig;
  /** Where the agent duel's record lives (duels/first-screen). */
  duelDir?: string;
  /** Where the trading arena's files live (arenas/up-or-down). */
  arenaDir?: string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(json);
}

async function readRaw(req: IncomingMessage, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

export function createApp(opts: AppOptions): { server: Server; broadcast: (e: StreamEvent) => void; simulate: () => CheckRecord | null } {
  const { store, experiments, scenarios } = opts;
  const clients = new Set<ServerResponse>();
  const startedAt = opts.startedAt ?? new Date().toISOString();

  const broadcast = (event: StreamEvent) => {
    const frame = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) c.write(frame);
  };
  const heartbeat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);
  heartbeat.unref();

  /** The config used for playground checks: the repo's config plus dashboard rule settings. */
  const effectiveConfig = (): GuardConfig => ({
    ...opts.baseConfig,
    rules: { ...opts.baseConfig.rules, ...store.data.settings.ruleSeverity },
  });

  const recordFromReport = (report: Report, extra: Partial<CheckRecord> = {}): CheckRecord => ({
    id: newId('c'),
    repo: report.repo ?? extra.repo ?? 'local',
    pr: report.pr,
    source: report.source ?? 'api',
    createdAt: report.createdAt ?? new Date().toISOString(),
    durationMs: report.durationMs ?? 0,
    verdict: report.verdict,
    counts: report.counts,
    stats: report.stats,
    affected: report.affectedExperiments ?? [],
    findings: report.findings ?? [],
    override: report.override,
    markdown: renderMarkdown(report, effectiveConfig()),
    diff: report.diff,
    ...extra,
  });

  const addCheck = (c: CheckRecord) => {
    store.addCheck(c);
    broadcast({ type: 'check', check: summarize(c) });
    return c;
  };

  const health = (): Health => ({
    ok: true,
    version: VERSION,
    mode: experiments.mode,
    startedAt,
    flagsmith: experiments.snapshot
      ? { source: experiments.snapshot.source, fetchedAt: experiments.snapshot.fetchedAt, environment: experiments.snapshot.environmentKey, running: experiments.running.length, error: experiments.error }
      : { source: 'error', running: 0, error: experiments.error },
    ingestProtected: !!opts.ingestToken,
    webhooks: { secretSet: !!opts.webhookSecret, received: webhookStats.received, lastAt: webhookStats.lastAt, github: !!opts.github },
  });

  const scenarioViews = (): ScenarioView[] => scenarios.scenarios.map(s => ({
    id: s.id, title: s.title, description: s.description, author: s.author, negative: !!s.negative, expect: s.expect,
    diff: formatUnifiedDiff(scenarioRepo(scenarios, s).diff()),
  }));

  type Handler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<void> | void;
  const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, pattern, keys, handler });
  };

  route('GET', '/api/health', (_q, res) => send(res, 200, health()));
  route('GET', '/api/client-config', (_q, res) => send(res, 200, opts.client ?? { experiments: null }));
  route('GET', '/api/duel', (_q, res) => send(res, 200, readDuel(opts.duelDir)));

  const arena = new Arena(opts.arenaDir);
  route('GET', '/api/arena', (_q, res) => send(res, 200, arena.view()));
  // The runner's own report of its paper trades. Without a token configured nobody can write it.
  route('POST', '/api/arena/state', async (req, res) => {
    if (!opts.ingestToken || req.headers.authorization !== `Bearer ${opts.ingestToken}`) throw new HttpError(401, 'Bad or missing token');
    arena.push(await readJson(req));
    send(res, 200, { ok: true });
  });

  route('GET', '/api/overview', (_q, res, _p, url) => {
    const days = Math.min(90, Math.max(7, Number(url.searchParams.get('days') ?? 30) || 30));
    send(res, 200, buildOverview(store.checks, experiments, store.data.settings, days));
  });

  route('GET', '/api/experiments', (_q, res) => {
    send(res, 200, experiments.experiments.map(e => experimentView(e, store.checks, experiments)));
  });

  route('GET', '/api/experiments/:id', (_q, res, p) => {
    const exp = experiments.experiments.find(e => String(e.id) === p.id || e.flagKey === p.id);
    if (!exp) throw new HttpError(404, 'Experiment not found');
    const view = experimentView(exp, store.checks, experiments);
    const checks = store.checks.filter(c => c.affected.some(a => String(a.id) === String(exp.id))).slice(0, 20).map(summarize);
    send(res, 200, { ...view, recentChecks: checks });
  });

  route('POST', '/api/experiments/refresh', async (_q, res) => {
    await experiments.refresh();
    broadcast({ type: 'snapshot', at: new Date().toISOString(), running: experiments.running.length });
    send(res, 200, health().flagsmith);
  });

  route('GET', '/api/checks', (_q, res, _p, url) => {
    const verdict = url.searchParams.get('verdict');
    const repo = url.searchParams.get('repo');
    const q = (url.searchParams.get('q') ?? '').toLowerCase().trim();
    const rule = url.searchParams.get('rule');
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100) || 100);
    const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0) || 0);
    let list = store.checks;
    if (verdict && verdict !== 'all') list = list.filter(c => c.verdict === verdict);
    if (repo && repo !== 'all') list = list.filter(c => c.repo === repo);
    if (rule) list = list.filter(c => c.findings.some(f => f.rule === rule));
    if (q) {
      list = list.filter(c => [c.repo, c.pr?.title, c.pr?.author, c.pr?.number, ...c.affected.map(a => a.name), ...c.findings.map(f => `${f.rule} ${f.file}`)]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    send(res, 200, { total: list.length, items: list.slice(offset, offset + limit).map(summarize), repos: [...new Set(store.checks.map(c => c.repo))].sort() });
  });

  route('GET', '/api/checks/:id', (_q, res, p) => {
    const c = store.getCheck(p.id);
    if (!c) throw new HttpError(404, 'Check not found');
    send(res, 200, c);
  });

  route('POST', '/api/checks', async (req, res) => {
    const body = await readJson(req);
    const snapshot = experiments.snapshot;
    if (!snapshot) throw new HttpError(503, `No Flagsmith snapshot: ${experiments.error ?? 'not loaded yet'}`);
    const config = effectiveConfig();
    if (body.scenarioId) {
      const s = scenarios.scenarios.find(x => x.id === body.scenarioId);
      if (!s) throw new HttpError(404, 'Scenario not found');
      const repo = scenarioRepo(scenarios, s);
      const report = runCheck({ repo, snapshot, config, meta: { repo: 'oakenshield/firstpr', source: 'playground', pr: { number: 0, title: s.prTitle ?? s.title, author: 'you' } } });
      return send(res, 201, addCheck(recordFromReport(report, { scenarioId: s.id, diff: formatUnifiedDiff(repo.diff()) })));
    }
    if (typeof body.diff === 'string' && body.diff.trim()) {
      const repo = new DiffOnlyRepoView(body.diff);
      if (repo.diff().length === 0) throw new HttpError(400, 'That does not look like a unified diff');
      const report = runCheck({ repo, snapshot, config, meta: { repo: String(body.repo ?? 'pasted-diff'), source: 'playground', pr: { number: 0, title: String(body.title ?? 'Pasted diff'), author: 'you' } } });
      return send(res, 201, addCheck(recordFromReport(report, { diff: body.diff })));
    }
    throw new HttpError(400, 'Send { scenarioId } or { diff }');
  });

  route('POST', '/api/reports', async (req, res) => {
    if (opts.ingestToken && req.headers.authorization !== `Bearer ${opts.ingestToken}`) throw new HttpError(401, 'Bad or missing token');
    const report = (await readJson(req, 8 * 1024 * 1024)) as Report;
    if (report?.tool !== 'experiment-guard' || !Array.isArray(report.findings)) throw new HttpError(400, 'Not an Experiment Guard report');
    send(res, 201, summarize(addCheck(recordFromReport(report))));
  });

  route('GET', '/api/rules', (_q, res) => send(res, 200, ruleViews(store.checks, store.data.settings)));

  route('PUT', '/api/rules/:id', async (req, res, p) => {
    const id = p.id.toUpperCase() as RuleId;
    if (!RULE_IDS.includes(id)) throw new HttpError(404, 'Unknown rule');
    const { severity } = await readJson(req);
    if (!['block', 'warn', 'info', 'off'].includes(severity)) throw new HttpError(400, 'severity must be block, warn, info or off');
    const settings = store.updateSettings({ ruleSeverity: { [id]: severity } });
    broadcast({ type: 'settings', settings });
    send(res, 200, ruleViews(store.checks, settings).find(r => r.id === id));
  });

  route('GET', '/api/settings', (_q, res) => send(res, 200, store.data.settings));

  route('PUT', '/api/settings', async (req, res) => {
    const body = (await readJson(req)) as Partial<Settings>;
    const patch: Partial<Settings> = {};
    if (body.hoursPerBlock !== undefined) {
      const h = Number(body.hoursPerBlock);
      if (!Number.isFinite(h) || h < 0 || h > 200) throw new HttpError(400, 'hoursPerBlock must be between 0 and 200');
      patch.hoursPerBlock = h;
    }
    const settings = store.updateSettings(patch);
    broadcast({ type: 'settings', settings });
    send(res, 200, settings);
  });

  route('GET', '/api/scenarios', (_q, res) => send(res, 200, scenarioViews()));

  /* ---------- Flagsmith webhooks ---------- */

  const webhookStats: { received: number; lastAt?: string } = { received: 0 };
  let queue: Promise<unknown> = Promise.resolve();
  // One event at a time: each compares the snapshot before and after its own refresh.
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const webhookDeps = () => ({
    store, experiments, config: effectiveConfig, addCheck, broadcast, newId, github: opts.github,
    log: (m: string) => console.warn(`[webhook] ${m}`),
  });

  route('POST', '/api/webhooks/flagsmith', async (req, res) => {
    const raw = await readRaw(req);
    const sig = req.headers['x-flagsmith-signature'];
    if (opts.webhookSecret && !verifySignature(raw, Array.isArray(sig) ? sig[0] : sig, opts.webhookSecret)) throw new HttpError(401, 'Bad or missing X-Flagsmith-Signature');
    let payload: unknown;
    try { payload = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Body must be JSON'); }
    webhookStats.received++;
    webhookStats.lastAt = new Date().toISOString();
    const r = await serial(() => handleFlagsmithEvent(webhookDeps(), payload, 'webhook'));
    send(res, 200, { ok: true, event: r.event.eventType, duplicate: !!r.duplicate, alerts: r.alerts.length, rechecked: r.rechecked, changed: r.changed.map(c => c.id) });
  });

  route('POST', '/api/flagsmith/simulate', async (req, res) => {
    if (experiments.mode !== 'demo') throw new HttpError(403, 'Simulation is only available on demo data');
    const { kind } = (await readJson(req)) as { kind?: SimulateKind };
    if (kind === 'reset') {
      experiments.resetDemo();
      await experiments.refresh();
      broadcast({ type: 'snapshot', at: new Date().toISOString(), running: experiments.running.length });
      return send(res, 200, { ok: true, reset: true });
    }
    if (kind !== 'start-experiment' && kind !== 'change-weights' && kind !== 'edit-segment') throw new HttpError(400, 'kind must be start-experiment, change-weights, edit-segment or reset');
    if (kind === 'start-experiment') {
      const now = Date.now();
      experiments.patchDemo(105, {
        status: 'running', startedAt: new Date(now).toISOString(), endsAt: new Date(now + 14 * 86_400_000).toISOString(),
        arms: [{ key: 'control', identities: 0 }, { key: 'sticky', identities: 0 }],
      });
    }
    const r = await serial(() => handleFlagsmithEvent(webhookDeps(), simulatedPayload(kind), 'simulated'));
    if (r.event.eventType) broadcast({ type: 'snapshot', at: new Date().toISOString(), running: experiments.running.length });
    send(res, 200, { ok: true, alerts: r.alerts, rechecked: r.rechecked, changed: r.changed.map(c => summarize(c)) });
  });

  route('GET', '/api/alerts', (_q, res, _p, url) => {
    const exp = url.searchParams.get('experiment');
    const limit = Math.min(300, Number(url.searchParams.get('limit') ?? 50) || 50);
    const list: FlagsmithAlert[] = store.alerts.filter(a => !exp || String(a.experimentId) === exp || a.flagKey === exp);
    send(res, 200, list.slice(0, limit));
  });

  route('GET', '/api/activity', (_q, res) => send(res, 200, store.checks.slice(0, 50).flatMap(activityFor).slice(0, 50)));

  route('GET', '/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ type: 'hello', at: new Date().toISOString() })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  const dashboardDir = opts.dashboardDir && existsSync(join(opts.dashboardDir, 'index.html')) ? resolve(opts.dashboardDir) : null;

  const serveStatic = (res: ServerResponse, pathname: string) => {
    if (!dashboardDir) {
      send(res, 200, { name: 'Oakenshield API', version: VERSION, hint: 'Dashboard not built. Run `npm run build` or `npm run dev`.' });
      return;
    }
    let file = normalize(join(dashboardDir, decodeURIComponent(pathname)));
    if (!file.startsWith(dashboardDir)) throw new HttpError(403, 'Forbidden');
    // The landing page is /index.html and the dashboard /app/index.html.
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    let status = 200;
    if (!existsSync(file)) {
      const notFound = join(dashboardDir, '404.html');
      [file, status] = existsSync(notFound) ? [notFound, 404] : [join(dashboardDir, 'index.html'), 200];
    }
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    const immutable = pathname.startsWith('/assets/');
    res.writeHead(status, { 'content-type': type, 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
    createReadStream(file).pipe(res);
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = url.pathname.match(r.pattern);
          if (!m) continue;
          const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
          await r.handler(req, res, params, url);
          return;
        }
        throw new HttpError(404, `No route for ${req.method} ${url.pathname}`);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
      serveStatic(res, url.pathname);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
  });
  server.on('close', () => clearInterval(heartbeat));
  // Demo mode: replay a seeded scenario as if a CI run had just reported it, so the dashboard feels live.
  let prNumber = 300 + Math.floor(Math.random() * 50);
  const DEMO_AUTHORS = ['priya', 'sam', 'maya', 'lee', 'arjun', 'nina', 'coding-agent'];
  const simulate = () => {
    const snapshot = experiments.snapshot;
    if (!snapshot || scenarios.scenarios.length === 0) return null;
    const s = scenarios.scenarios[Math.floor(Math.random() * scenarios.scenarios.length)];
    const repo = scenarioRepo(scenarios, s);
    const author = DEMO_AUTHORS[Math.floor(Math.random() * DEMO_AUTHORS.length)];
    const pr = { number: ++prNumber, title: s.prTitle ?? s.title, author, branch: `${author}/${s.id}` };
    const report = runCheck({ repo, snapshot, config: effectiveConfig(), meta: { repo: 'oakenshield/firstpr', source: author === 'coding-agent' ? 'mcp' : 'ci', pr } });
    return addCheck(recordFromReport(report, { scenarioId: s.id, diff: formatUnifiedDiff(repo.diff()) }));
  };

  return { server, broadcast, simulate };
}
