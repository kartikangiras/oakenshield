import { useState } from 'react';
import { Icon } from '../components/Icons.tsx';
import type { IconName } from '../components/Icons.tsx';
import { AlertRow } from '../components/alerts.tsx';
import { Card, CodeBlock, CopyButton, PageHead, Section, Seg, TimeAgo, cx, useToast } from '../components/ui.tsx';
import { trackEvent } from '../lib/experiments.ts';
import { api } from '../lib/api.ts';
import type { SimulateKind } from '../lib/api.ts';
import { useLive } from '../lib/live.tsx';

type Snippet = 'action' | 'config' | 'mcp' | 'cli' | 'ingest';
type Surface = 'pr' | 'agent' | 'cli' | 'dash';

const SURFACES: Array<{ key: Surface; icon: IconName; title: string; where: string; body: string; hint: string; snippets: Array<{ key: Snippet; label: string }> }> = [
  {
    key: 'pr', icon: 'github', title: 'Pull requests', where: 'GitHub Action',
    body: 'Comments on every pull request, suggests the fix, and fails the check when a change would corrupt a running experiment.',
    hint: 'Push this repository to GitHub, then reference it from any repo as owner/oakenshield@main (or a tag). Add the config file to tune rules.',
    snippets: [{ key: 'action', label: 'Workflow' }, { key: 'config', label: '.experiment-guard.yml' }],
  },
  {
    key: 'agent', icon: 'bot', title: 'Coding agents', where: 'MCP server',
    body: 'Claude Code, Cursor and other MCP clients check their own edits before they touch experiment code.',
    hint: 'The agent calls check_experiment_impact on its uncommitted changes and gets the same findings a pull request would.',
    snippets: [{ key: 'mcp', label: 'MCP config' }],
  },
  {
    key: 'cli', icon: 'terminal', title: 'Terminal', where: 'CLI',
    body: 'Check your branch, or uncommitted work, before you push. Runs in any CI as well.',
    hint: 'Exit code 1 means a blocking finding, so the same command can gate any CI system, not only GitHub.',
    snippets: [{ key: 'cli', label: 'Commands' }],
  },
  {
    key: 'dash', icon: 'grid', title: 'This dashboard', where: 'Oakenshield server',
    body: 'Results from every repository in one place, rule settings, and a playground for trying changes.',
    hint: 'Start the server with OAKENSHIELD_TOKEN set, then point CI at it with report-url and report-token.',
    snippets: [{ key: 'ingest', label: 'Send results here' }],
  },
];

const WORKFLOW = `# .github/workflows/experiment-guard.yml
name: Experiment Guard
on:
  pull_request:
    types: [opened, synchronize, reopened, labeled, unlabeled]

permissions:
  contents: read
  pull-requests: write
  id-token: write        # Flagsmith OIDC: no API key stored in GitHub

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: kartikangiras/oakenshield@main
        with:
          flagsmith-environment: \${{ vars.FLAGSMITH_ENVIRONMENT }}
          report-url: \${{ vars.OAKENSHIELD_URL }}        # optional: send results here
          report-token: \${{ secrets.OAKENSHIELD_TOKEN }}
`;

const CONFIG = `# .experiment-guard.yml
version: 1
flagsmith:
  environment: prod_env_key   # where your experiments run
  auth: oidc                  # or api_key, read from FLAGSMITH_API_KEY
  fail_open: true             # if Flagsmith is unreachable, warn instead of failing
scan:
  include: ["app/**", "src/**", "package.json"]
identity_patterns:
  - fp_vid                    # storage keys or cookies behind your identity
calls:                        # your own functions that wrap the SDK
  exposure: [useVariant]
  conversion: [track]
rules:
  EG006: warn                 # block | warn | info | off
override:
  label: experiment-guard:override
  min_permission: maintain
`;

const MCP = `{
  "mcpServers": {
    "experiment-guard": {
      "command": "node",
      "args": ["/path/to/oakenshield/packages/guard/bin/experiment-guard.js", "mcp"],
      "env": {
        "FLAGSMITH_API_KEY": "<organisation API key>",
        "GUARD_FLAGSMITH_ENVIRONMENT": "<environment key>"
      }
    }
  }
}

# Claude Code
claude mcp add experiment-guard -- node /path/to/oakenshield/packages/guard/bin/experiment-guard.js mcp --demo`;

const CLI = `# One time, from your oakenshield clone: put experiment-guard on your PATH
cd packages/guard && npm link

# Then, inside any repository: check your branch before you push
experiment-guard check --base origin/main

# Include uncommitted changes
experiment-guard check --base origin/main --head WORKTREE

# Try it without a Flagsmith account
experiment-guard check --demo --base HEAD~1

# What's protected right now, and why a rule fired
experiment-guard snapshot
experiment-guard explain EG006`;

export function IntegrationsPage() {
  const { health, healthError, refreshHealth } = useLive();
  const [where, setWhere] = useState<Surface>('pr');
  const [snippet, setSnippet] = useState<Snippet>('action');
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://localhost:8787';
  const INGEST = `# Send any Experiment Guard run to this dashboard
export OAKENSHIELD_TOKEN=<the token the server was started with>
experiment-guard check --base origin/main --report-url ${origin}

# Or post a saved JSON report
curl -X POST ${origin}/api/reports \\
  -H "authorization: Bearer $OAKENSHIELD_TOKEN" \\
  -H "content-type: application/json" \\
  --data @report.json`;

  const fs = health?.flagsmith;
  const refresh = async () => {
    setRefreshing(true);
    try {
      const f = await api.refreshExperiments();
      refreshHealth();
      toast({ kind: f.source === 'error' ? 'block' : 'pass', title: f.source === 'error' ? 'Flagsmith returned an error' : 'Snapshot refreshed', body: f.error ?? `${f.running} running experiments` });
    } catch (e) {
      toast({ kind: 'block', title: 'Refresh failed', body: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  const surface = SURFACES.find(x => x.key === where)!;
  const code = { action: WORKFLOW, config: CONFIG, mcp: MCP, cli: CLI, ingest: INGEST }[snippet];
  const lang = snippet === 'action' || snippet === 'config' ? 'yaml' : snippet === 'mcp' ? 'json' : 'shell';
  const pick = (k: Surface) => { setWhere(k); setSnippet(SURFACES.find(x => x.key === k)!.snippets[0].key); };

  return (
    <div className="fade-in">
      <PageHead title="Set up" sub="Experiment Guard runs where code changes: on pull requests, inside coding agents and in the terminal. This dashboard collects what it finds." />

      <Section title="Where Experiment Guard runs" sub="Pick a place to see exactly how to set it up.">
        <div className="grid cols-4">
        {SURFACES.map(x => (
          <button key={x.key} type="button" className={cx('card', 'pick', where === x.key && 'on')} aria-pressed={where === x.key} onClick={() => pick(x.key)}>
            <span className={cx('feed-badge', where === x.key && 'v-brand')}><Icon name={x.icon} size={16} /></span>
            <div>
              <div className="card-title">{x.title}</div>
              <div className="small faint">{x.where}</div>
            </div>
            <div className="small muted">{x.body}</div>
          </button>
        ))}
        </div>
        <div className="card card-pad stack" style={{ gap: 16 }}>
            {surface.snippets.length > 1 && (
              <div><Seg<Snippet> value={snippet} onChange={setSnippet} options={surface.snippets.map(x => ({ value: x.key, label: x.label }))} /></div>
            )}
            {/* Guardrail metric of the demo_start A/B test (docs/experiment.md). */}
            <CodeBlock code={code} lang={lang} title={surface.snippets.find(x => x.key === snippet)?.label ?? surface.title} onCopy={() => trackEvent('setup_snippet_copied')} />
            <div className="small faint">{surface.hint}</div>
        </div>
      </Section>

      <Section title="Connect Flagsmith" sub="Experiment Guard reads the experiments running in Flagsmith, and listens for changes to them.">
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <Card
            title={<><Icon name="flask" size={15} />Flagsmith</>}
            sub="Read from the Flagsmith Admin API on every check"
            actions={<button className="btn sm" onClick={refresh} disabled={refreshing}><Icon name="refresh" size={13} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />Refresh now</button>}
          >
            {healthError ? <div className="small" style={{ color: 'var(--block)' }}>{healthError}</div> : !fs ? <div className="faint small">Loading…</div> : (
              <div className="kv">
                <div className="kv-row"><span className="muted">Status</span>{fs.source === 'error' ? <span className="chip v-block">Error</span> : <span className="chip v-pass"><span className="dot" />{fs.source === 'demo' ? 'Demo data' : 'Connected'}</span>}</div>
                <div className="kv-row"><span className="muted">Environment</span><span className="mono">{fs.environment ?? 'Not set'}</span></div>
                <div className="kv-row"><span className="muted">Running experiments</span><b className="tnum">{fs.running}</b></div>
                <div className="kv-row"><span className="muted">Last read</span><span>{fs.fetchedAt ? <TimeAgo iso={fs.fetchedAt} /> : 'Not yet'}</span></div>
              </div>
            )}
            {fs?.error && <div className="small" style={{ color: 'var(--block)', marginTop: 12 }}>{fs.error}</div>}
            {health?.mode === 'demo' && (
              <div className="small muted" style={{ marginTop: 16, padding: 12, borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                To use your own Flagsmith project, restart the server with <code className="mono">OAKENSHIELD_MODE=live</code>,{' '}
                <code className="mono">FLAGSMITH_API_KEY</code> and <code className="mono">GUARD_FLAGSMITH_ENVIRONMENT</code>.
                Set <code className="mono">OAKENSHIELD_REPO_PATH</code> to a checkout to see live code references.
              </div>
            )}
          </Card>
          <WebhookCard origin={origin} />
        </div>
        {health?.mode === 'demo' && <SimulateCard />}
      </Section>

    </div>
  );
}

function WebhookCard({ origin }: { origin: string }) {
  const { health } = useLive();
  const url = `${origin}/api/webhooks/flagsmith`;
  const wh = health?.webhooks;
  return (
    <Card
      title={<><Icon name="bell" size={15} />Webhooks</>}
      sub="Flagsmith tells Experiment Guard when flags, segments or experiments change"
      actions={wh && <span className={cx('chip', wh.received ? 'v-pass' : '')}>{wh.received ? `${wh.received} received` : 'None yet'}</span>}
    >
      <div className="stack" style={{ gap: 16 }}>
        <div>
          <div className="small faint" style={{ marginBottom: 8 }}>Webhook URL</div>
          <div className="row" style={{ gap: 8 }}>
            <code className="mono input" style={{ flex: 1, display: 'flex', alignItems: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{url}</code>
            <CopyButton text={url} />
          </div>
        </div>
        <ol className="steps">
          <li><b>Organisation settings → Webhooks</b><span>Add the URL. Flagsmith sends every flag change and the audit log, including segment edits.</span></li>
          <li><b>Or: Environment settings → Webhooks</b><span>Flag changes only, for one environment. If you add both, duplicate deliveries are ignored.</span></li>
          <li>
            <b>Use one secret on both</b>
            <span>
              Start the server with <code className="mono">OAKENSHIELD_WEBHOOK_SECRET</code>.{' '}
              {wh && (wh.secretSet ? <em style={{ color: 'var(--pass)', fontStyle: 'normal' }}>Set.</em> : <em style={{ color: 'var(--warn)', fontStyle: 'normal' }}>Not set yet, so unsigned deliveries are accepted.</em>)}
            </span>
          </li>
          <li>
            <b>Optional: GitHub token</b>
            <span>
              With <code className="mono">GITHUB_TOKEN</code>, re-checks update PR comments and commit statuses.{' '}
              {wh?.github && <em style={{ color: 'var(--pass)', fontStyle: 'normal' }}>Connected.</em>}
            </span>
          </li>
        </ol>
      </div>
    </Card>
  );
}

const SIMULATIONS: Array<{ kind: SimulateKind; label: string; body: string; icon: IconName }> = [
  { kind: 'start-experiment', label: 'Start an experiment', body: '"Sticky docs sign-up CTA" goes live. Two open docs pull requests touch its code and flip to blocked.', icon: 'play' },
  { kind: 'change-weights', label: 'Change a running flag', body: 'Someone moves onboarding_flow from 50/50 to 70/30 in the middle of the experiment.', icon: 'sliders' },
  { kind: 'edit-segment', label: 'Edit an audience segment', body: '"First-time visitors", the audience of Connect-first onboarding, changes underneath it.', icon: 'users' },
];

function SimulateCard() {
  const { alerts } = useLive();
  const toast = useToast();
  const [busy, setBusy] = useState<SimulateKind | null>(null);
  const run = async (kind: SimulateKind) => {
    setBusy(kind);
    try {
      const r = await api.simulate(kind);
      if (kind === 'reset') toast({ kind: 'info', title: 'Demo reset', body: 'Experiments are back to their starting state.' });
      else if (!r.alerts?.length) toast({ kind: 'info', title: 'Nothing changed', body: 'That change was already applied. Reset the demo to run it again.' });
    } catch (e) {
      toast({ kind: 'block', title: 'Simulation failed', body: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card
      title={<><Icon name="sparkles" size={15} />Try it on demo data</>}
      sub="Each button sends the same payload Flagsmith would, through the same code path"
      actions={<button type="button" className="btn ghost sm" disabled={busy !== null} onClick={() => run('reset')}><Icon name="refresh" size={13} />Reset demo</button>}
    >
      <div className="stack" style={{ gap: 24 }}>
        <div className="grid cols-3">
          {SIMULATIONS.map(sim => (
            <button key={sim.kind} type="button" className="sim" disabled={busy !== null} onClick={() => run(sim.kind)}>
              <span className="feed-badge v-brand" style={{ width: 34, height: 34, borderRadius: 12 }}>
                <Icon name={busy === sim.kind ? 'refresh' : sim.icon} size={16} style={busy === sim.kind ? { animation: 'spin 1s linear infinite' } : undefined} />
              </span>
              <span style={{ fontWeight: 600 }}>{sim.label}</span>
              <span className="small muted">{sim.body}</span>
            </button>
          ))}
        </div>
        {alerts.length > 0 && (
          <div>
            <div className="section-title" style={{ marginBottom: 8 }}>What happened</div>
            <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
              <div className="feed">{alerts.slice(0, 3).map(a => <AlertRow key={a.id} a={a} compact />)}</div>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
