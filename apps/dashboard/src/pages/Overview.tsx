import { Legend, StackedBars, VERDICT_SERIES } from '../components/charts.tsx';
import { Icon } from '../components/Icons.tsx';
import { Card, Empty, ErrorState, PageHead, Section, Skeleton, VerdictChip } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CheckSummary, Overview } from '../lib/api.ts';
import { SOURCE_LABEL, num, pct } from '../lib/format.ts';
import { navigate, useAsync } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';
import { SOURCE_ICON } from './Checks.tsx';
import { DuelReplay } from './Duel.tsx';

const DAYS = 30;

export function OverviewPage() {
  const { tick } = useLive();
  const ov = useAsync(() => api.overview(DAYS), [tick]);
  const recent = useAsync(() => api.checks({ limit: 6 }), [tick]);

  if (ov.error && !ov.data) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const o = ov.data;
  return (
    <div className="fade-in">
      <PageHead
        title="Overview"
        sub={(
          <>
            The latest duel between two agents, and what Experiment Guard decided on recent pull requests.
            {o?.mode === 'demo' && <> <a href="#/integrations" className="chip" title="Connect Flagsmith on the Set up page">Demo data</a></>}
          </>
        )}
        actions={<button className="btn primary" onClick={() => navigate('/playground')}><Icon name="play" size={14} />Run a check</button>}
      />

      <DuelReplay />

      <Section title="Pull requests" sub={`Experiment Guard checks each one against the A/B tests running in Flagsmith. These are the last ${DAYS} days.`}>
        <div className="grid split">
          <VerdictCard ov={o} />
          <LatestChecksCard recent={recent.data?.items} />
        </div>
      </Section>
    </div>
  );
}

function VerdictCard({ ov }: { ov: Overview | undefined }) {
  const k = ov?.kpis;
  const numbers = [
    { label: 'Checks run', value: k ? num(k.checks) : '' },
    { label: 'Merges blocked', value: k ? num(k.blocks) : '' },
    { label: 'Clean pass rate', value: k ? pct(k.passRate, 1) : '' },
  ];
  return (
    <Card title="Checks by verdict" sub="Every pull request, command line and agent check, per day">
      <div className="kpis">
        {numbers.map(n => (
          <div key={n.label}>
            {k ? <div className="kpi-value">{n.value}</div> : <Skeleton h={36} w={96} />}
            <div className="kpi-label">{n.label}</div>
          </div>
        ))}
      </div>
      <div style={{ marginBottom: 12 }}>
        <Legend items={[...VERDICT_SERIES].reverse().map(s => ({ label: s.label, color: s.color }))} />
      </div>
      {ov ? <StackedBars data={ov.series} /> : <Skeleton h={240} />}
    </Card>
  );
}

function LatestChecksCard({ recent }: { recent: CheckSummary[] | undefined }) {
  return (
    <Card title="Latest checks" sub="Newest first, from CI, the CLI and coding agents" actions={<a className="btn ghost sm" href="#/checks">All checks<Icon name="chevronRight" size={13} /></a>}>
      {!recent ? <div className="stack"><Skeleton h={44} /><Skeleton h={44} /><Skeleton h={44} /></div> : recent.length === 0 ? (
        <Empty icon="pr" title="No checks yet">Open a pull request or run a check in the playground.</Empty>
      ) : (
        <div className="tx-list">{recent.slice(0, 6).map(c => <CheckLine key={c.id} c={c} />)}</div>
      )}
    </Card>
  );
}

function CheckLine({ c }: { c: CheckSummary }) {
  const when = new Date(c.createdAt);
  return (
    <div className="tx" onClick={() => navigate(`/checks/${c.id}`)}>
      <span className="tx-chip" title={SOURCE_LABEL[c.source]}><Icon name={SOURCE_ICON[c.source]} size={16} /></span>
      <div style={{ minWidth: 0 }}>
        <div className="tx-title">{c.pr?.title ?? (c.source === 'mcp' ? 'Coding agent check' : 'Local change')}</div>
        <div className="tx-sub">{c.repo.split('/').pop()}{c.pr?.number ? ` #${c.pr.number}` : ''} · {when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, {when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div>
      </div>
      <div className="stack" style={{ gap: 2, alignItems: 'flex-end' }}>
        <VerdictChip verdict={c.verdict} />
        {c.rules[0] && c.verdict !== 'pass' && <span className="tx-sub mono">{c.rules[0]}</span>}
      </div>
    </div>
  );
}
