import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { demoSnapshot, loadConfig, loadScenarioSet } from '@oakenshield/guard';
import { createApp } from './app.ts';
import { ExperimentService } from './experiments.ts';
import { generateDemoChecks } from './seed.ts';
import { Store } from './store.ts';
import { gitHubPoster } from './webhooks.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const env = process.env;

const port = Number(env.PORT ?? 8787);
const host = env.HOST ?? '127.0.0.1';
const scenarios = loadScenarioSet();

// Live mode reads Flagsmith through the repo's .experiment-guard.yml (or env overrides).
const repoPath = env.OAKENSHIELD_REPO_PATH;
const { config: repoConfig } = loadConfig(repoPath ?? process.cwd(), env.OAKENSHIELD_CONFIG);
const liveConfigured = !!(env.GUARD_FLAGSMITH_ENVIRONMENT ?? repoConfig.flagsmith.environment) && !!(env.FLAGSMITH_API_KEY || repoConfig.flagsmith.auth === 'cli');
const mode: 'demo' | 'live' = env.OAKENSHIELD_MODE === 'live' || (env.OAKENSHIELD_MODE !== 'demo' && liveConfigured) ? 'live' : 'demo';

const baseConfig = mode === 'demo' ? scenarios.config : repoConfig;
const dataFile = env.OAKENSHIELD_DATA ?? here(`../.data/oakenshield-${mode}.json`);
const store = new Store(dataFile);
const experiments = new ExperimentService({ mode, config: baseConfig, repoPath, demoFiles: scenarios.baseFiles });
await experiments.refresh();

if (mode === 'demo' && (store.checks.length === 0 || env.OAKENSHIELD_RESEED === '1')) {
  const checks = generateDemoChecks({ set: scenarios, snapshot: experiments.snapshot ?? demoSnapshot(), config: baseConfig });
  store.replaceChecks(checks, new Date().toISOString());
  store.flush();
  console.log(`[oakenshield] seeded ${checks.length} demo checks`);
}

// Keep the snapshot fresh in live mode.
if (mode === 'live') setInterval(() => void experiments.refresh(), Number(env.OAKENSHIELD_REFRESH_SECONDS ?? 300) * 1000).unref();

const dashboardDir = env.OAKENSHIELD_DASHBOARD_DIR ?? here('../../dashboard/dist');
const { server, simulate } = createApp({
  store, experiments, scenarios, baseConfig,
  dashboardDir: existsSync(dashboardDir) ? dashboardDir : undefined,
  ingestToken: env.OAKENSHIELD_TOKEN,
  webhookSecret: env.OAKENSHIELD_WEBHOOK_SECRET,
  // Demo pull requests are not real, so only live mode writes back to GitHub.
  github: mode === 'live' && env.GITHUB_TOKEN ? gitHubPoster(env.GITHUB_TOKEN, env.GITHUB_API_URL) : undefined,
  duelDir: env.OAKENSHIELD_DUEL_DIR ?? here('../../../duels/first-screen'),
  // The dashboard's own A/B test (docs/experiment.md). Off unless an environment key is set.
  client: {
    experiments: env.DASHBOARD_FLAGSMITH_ENVIRONMENT ? {
      environmentKey: env.DASHBOARD_FLAGSMITH_ENVIRONMENT,
      apiUrl: env.DASHBOARD_FLAGSMITH_API_URL || undefined,
      eventsApiUrl: env.DASHBOARD_FLAGSMITH_EVENTS_URL || undefined,
    } : null,
  },
});

// Demo mode replays a scenario every OAKENSHIELD_DEMO_TICK seconds (0 turns it off).
const tick = Number(env.OAKENSHIELD_DEMO_TICK ?? 45);
if (mode === 'demo' && tick > 0) setInterval(simulate, tick * 1000).unref();

server.listen(port, host, () => {
  console.log(`[oakenshield] ${mode} mode · API on http://${host}:${port}/api · ${experiments.running.length} running experiment(s)`);
  if (existsSync(dashboardDir)) console.log(`[oakenshield] dashboard on http://${host}:${port}/`);
});

const shutdown = () => {
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
