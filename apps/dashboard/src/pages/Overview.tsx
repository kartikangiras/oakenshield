import { useState } from 'react';
import { ArmSplit, HBars, Legend, StackedBars, VERDICT_SERIES } from '../components/charts.tsx';
import { alertTarget } from '../components/alerts.tsx';
import { Icon } from '../components/Icons.tsx';
import { Card, Empty, ErrorState, PageHead, Section, Seg, Skeleton, StatusChip, VerdictChip, cx, useCountUp, useToast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CheckSummary, ExperimentView, Overview } from '../lib/api.ts';
import { SOURCE_LABEL, dayLabel, delta, duration, num, pct } from '../lib/format.ts';
import { navigate, useAsync, useLocalStorage } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';
import { SOURCE_ICON } from './Checks.tsx';
import { DuelBanner } from './Duel.tsx';

type Range = '7' | '30' | '90';

export function OverviewPage() {
  const { tick } = useLive();
  const [range, setRange] = useLocalStorage<Range>('oak-range', '30');
  const ov = useAsync(() => api.overview(Number(range)), [range, tick]);
  const exps = useAsync(() => api.experiments(), [tick]);
  const recent = useAsync(() => api.checks({ limit: 12 }), [tick]);
  const settings = useAsync(() => api.settings(), [tick]);
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();
  const { refreshHealth } = useLive();

  const refresh = async () => {
    setRefreshing(true);
    try {
      const f = await api.refreshExperiments();
      refreshHealth();
      exps.reload();
      toast({ kind: 'pass', title: 'Snapshot refreshed', body: `${f.running} running experiments from ${f.source}` });
    } catch (e) {
      toast({ kind: 'block', title: 'Refresh failed', body: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  if (ov.error && !ov.data) return <ErrorState error={ov.error} onRetry={ov.reload} />;
  const o = ov.data;
  const days = o?.rangeDays ?? Number(range);
  return (
    <div className="fade-in">
      <PageHead
        title="Overview"
        sub={(
          <>
            Experiment Guard checks every pull request against the A/B tests running in Flagsmith. This is what it decided in the last {days} days.
            {o?.mode === 'demo' && <> <a href="#/integrations" className="chip" title="Connect Flagsmith on the Set up page">Demo data</a></>}
          </>
        )}
        actions={(
          <>
            <Seg<Range> value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
            <button className="btn primary" onClick={() => navigate('/playground')}><Icon name="play" size={14} />Run a check</button>
          </>
        )}
      />

      <div className="stack">
        <LatestAlert />
        <DuelBanner />
        <Kpis ov={o} hoursPerBlock={settings.data?.hoursPerBlock ?? 6} />
      </div>

      <Section
        title="Pull requests"
        sub="Passed, warned, blocked or overridden by a maintainer, day by day."
        actions={<button className="btn" onClick={() => navigate('/playground?runall=1')}><Icon name="layers" size={14} />Run all scenarios</button>}
      >
        <div className="grid split">
          <VerdictChart ov={o} />
          <LatestChecksCard recent={recent.data?.items} />
        </div>
      </Section>

      <Section
        title="Guarded experiments"
        sub="Running in Flagsmith and protected on every pull request. Open one to see its code and audience."
        actions={(
          <button className="btn" onClick={refresh} disabled={refreshing}>
            <Icon name="refresh" size={14} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />Refresh from Flagsmith
          </button>
        )}
      >
        <GuardedExperiments exps={exps.data} />
      </Section>

      <Section title="Where findings come from" sub="Which rules fire most, and in which repositories.">
        <div className="grid cols-2">
          <RuleChart ov={o} />
          <Repos ov={o} />
        </div>
      </Section>
    </div>
  );
}

/* ---------- latest Flagsmith alert ---------- */

function LatestAlert() {
  const { alerts } = useLive();
  const [dismissed, setDismissed] = useState<string | null>(null);
  // The newest alert from the last day that needs attention; failing that, the newest one that
  // says something happened (a re-check that changed nothing is left to the bell).
  const fresh = alerts.filter(x => Date.now() - Date.parse(x.at) <= 86_400_000);
  const a = fresh.find(x => x.severity !== 'info') ?? fresh.find(x => !(x.kind === 'recheck' && !x.checkIds?.length));
  if (!a || a.id === dismissed) return null;
  const target = alertTarget(a);
  return (
    <div className={cx('alert-strip', 'fade-in', `sev-${a.severity}`)} style={{ margin: 0 }} onClick={() => target && navigate(target)}>
      <span className={cx('feed-badge', a.severity === 'block' ? 'v-block' : a.severity === 'warn' ? 'v-warn' : 'v-info')}><Icon name="bell" size={14} /></span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontWeight: 600 }}>{a.title}</div>
        <div className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.detail}</div>
      </div>
      <span className="small faint">From Flagsmith</span>
      <button className="btn ghost sm icon" aria-label="Dismiss" onClick={e => { e.stopPropagation(); setDismissed(a.id); }}><Icon name="x" size={14} /></button>
    </div>
  );
}

/* ---------- the four numbers ---------- */

function Kpis({ ov, hoursPerBlock }: { ov: Overview | undefined; hoursPerBlock: number }) {
  const k = ov?.kpis;
  const hours = Math.round(useCountUp(k?.hoursSaved ?? 0, 900));
  const days = ov?.rangeDays ?? 30;
  // With nothing in the previous period there is no percentage to show.
  const against = (now: number, prev: number) => {
    if (prev <= 0) return `Nothing in the ${days} days before`;
    const d = delta(now, prev);
    return d.dir === 'flat' ? `The same as the ${days} days before` : `${(Math.abs(d.pct) * 100).toFixed(0)}% ${d.dir === 'up' ? 'more' : 'fewer'} than the ${days} days before`;
  };
  const cards = [
    { label: 'Checks run', icon: 'pr', value: k ? num(k.checks) : '', foot: k ? against(k.checks, k.checksPrev) : '' },
    { label: 'Merges blocked', icon: 'octagon', value: k ? num(k.blocks) : '', foot: k ? against(k.blocks, k.blocksPrev) : '' },
    { label: 'Clean pass rate', icon: 'shieldCheck', value: k ? pct(k.passRate, 1) : '', foot: k ? `Median check takes ${duration(k.medianDurationMs)}` : '' },
    { label: 'Analyst hours saved', icon: 'clock', value: k ? num(hours) : '', foot: k ? `${num(k.blocks)} broken experiments avoided, ${hoursPerBlock} hours each` : '' },
  ] as const;
  return (
    <div className="kpis">
      {cards.map(c => (
        <div key={c.label} className="card kpi">
          <div className="kpi-label">{c.label}<Icon name={c.icon} size={16} style={{ color: 'var(--text-3)' }} /></div>
          {k ? <div className="kpi-value">{c.value}</div> : <Skeleton h={36} w={96} />}
          <div className="kpi-foot">{c.foot || '\u00a0'}</div>
        </div>
      ))}
    </div>
  );
}

/* ---------- cards ---------- */

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

const REF_KINDS = [
  { kind: 'exposure', label: 'Exposure calls', icon: 'eye' },
  { kind: 'variant', label: 'Variant branches', icon: 'branch' },
  { kind: 'conversion', label: 'Metric events', icon: 'target' },
] as const;

function GuardedExperiments({ exps }: { exps: ExperimentView[] | undefined }) {
  if (!exps) return <div className="grid cols-3">{[0, 1, 2].map(i => <Skeleton key={i} h={304} style={{ borderRadius: 16 }} />)}</div>;
  const running = exps.filter(e => e.status === 'running');
  if (running.length === 0) return <div className="card"><Empty icon="flask" title="No running experiments">Start an experiment in Flagsmith and it shows up here within a minute.</Empty></div>;
  return (
    <div className="grid cols-3">
      {running.map(e => (
        <div key={e.id} className="card spotlight-card" onClick={() => navigate(`/experiments/${e.id}`)}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <StatusChip status={e.status} />
            <span className="chip mono">{e.flagKey}</span>
          </div>
          <div>
            <div className="exp-name">{e.name}</div>
            {e.hypothesis && <div className="small muted clamp-2" style={{ marginTop: 4 }}>{e.hypothesis}</div>}
          </div>
          {e.arms && e.arms.length > 0 && <ArmSplit arms={e.arms} />}
          <div className="kv">
            {REF_KINDS.map(r => (
              <div key={r.kind} className="kv-row">
                <span className="row muted"><Icon name={r.icon} size={14} />{r.label}</span>
                <b className="tnum">{e.references.filter(x => x.kind === r.kind).length}</b>
              </div>
            ))}
            {e.audience && e.audience.length > 0 && (
              <div className="kv-row">
                <span className="row muted"><Icon name="users" size={14} />Audience</span>
                <span className="small" style={{ textAlign: 'right' }}>{e.audience.map(a => a.name).join(', ')}</span>
              </div>
            )}
          </div>
          <div className="row" style={{ justifyContent: 'space-between', marginTop: 'auto' }}>
            <span className="small faint">{num(e.checks)} checks touched it</span>
            <span className="row" style={{ gap: 4 }}>
              <span className="chip v-block" title="Blocked pull requests"><Icon name="octagon" size={11} />{e.blocks}</span>
              <span className="chip v-warn" title="Warnings"><Icon name="alert" size={11} />{e.warns}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function VerdictChart({ ov }: { ov: Overview | undefined }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const sums = VERDICT_SERIES.map(s => ({ ...s, total: ov?.series.reduce((n, d) => n + d[s.key], 0) ?? 0 }));
  return (
    <Card
      title="Checks by verdict"
      sub="Every pull request, command line and agent check, per day"
      actions={<Seg<'chart' | 'table'> size="sm" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />}
    >
      <div style={{ marginBottom: 12 }}>
        <Legend items={[...sums].reverse().map(s => ({ label: s.label, color: s.color, value: num(s.total) }))} />
      </div>
      {!ov ? <Skeleton h={240} /> : view === 'chart' ? (
        <StackedBars data={ov.series} />
      ) : (
        <div style={{ maxHeight: 240, overflow: 'auto' }}>
          <table className="table">
            <thead><tr><th>Day</th>{[...VERDICT_SERIES].reverse().map(s => <th key={s.key} style={{ textAlign: 'right' }}>{s.label}</th>)}</tr></thead>
            <tbody>
              {[...ov.series].reverse().map(d => (
                <tr key={d.date} style={{ cursor: 'default' }}>
                  <td>{dayLabel(d.date)}</td>
                  {[...VERDICT_SERIES].reverse().map(s => <td key={s.key} className="tnum" style={{ textAlign: 'right' }}>{d[s.key]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const SEV_COLOR = { block: 'var(--m-block)', warn: 'var(--m-warn)', info: 'var(--m-info)' } as const;

function RuleChart({ ov }: { ov: Overview | undefined }) {
  const rows = (ov?.byRule ?? []).filter(r => r.count > 0).slice(0, 8);
  return (
    <Card title="Findings by rule" sub="Click a rule to see the checks it fired on">
      <div style={{ marginBottom: 8 }}>
        <Legend items={[{ label: 'Blocks', color: SEV_COLOR.block }, { label: 'Warns', color: SEV_COLOR.warn }, { label: 'Info', color: SEV_COLOR.info }]} />
      </div>
      {!ov ? <Skeleton h={220} /> : rows.length === 0 ? <Empty icon="shieldCheck" title="No findings in this range" /> : (
        <HBars
          rows={rows.map(r => ({ key: r.rule, label: r.rule, value: r.count, color: SEV_COLOR[r.severity], hint: r.title }))}
          onSelect={rule => navigate(`/checks?rule=${rule}`)}
        />
      )}
      {rows.length > 0 && (
        <div className="small faint" style={{ marginTop: 12 }}>
          Most common: <b style={{ color: 'var(--text-2)' }}>{rows[0].title}</b>
        </div>
      )}
    </Card>
  );
}

function Repos({ ov }: { ov: Overview | undefined }) {
  if (!ov || ov.byRepo.length === 0) return null;
  const max = Math.max(...ov.byRepo.map(r => r.checks));
  return (
    <Card title="Repositories" sub="Where checks ran in this range" pad={false}>
      <div style={{ marginTop: 12 }}>
        <table className="table">
          <thead><tr><th>Repository</th><th style={{ width: '40%' }}>Checks</th><th style={{ textAlign: 'right' }}>Blocked</th><th style={{ textAlign: 'right' }}>Block rate</th></tr></thead>
          <tbody>
            {ov.byRepo.map(r => (
              <tr key={r.repo} onClick={() => navigate(`/checks?repo=${encodeURIComponent(r.repo)}`)}>
                <td><span className="row"><Icon name="branch" size={14} /><span className="mono">{r.repo}</span></span></td>
                <td>
                  <div className="row">
                    <div className="hbar-track" style={{ flex: 1 }}><div className="hbar-fill" style={{ width: `${(r.checks / max) * 100}%`, background: 'var(--m-brand)' }} /></div>
                    <span className="tnum small" style={{ width: 40, textAlign: 'right' }}>{num(r.checks)}</span>
                  </div>
                </td>
                <td className="tnum" style={{ textAlign: 'right' }}>{num(r.blocks)}</td>
                <td className="tnum" style={{ textAlign: 'right' }}>{pct(r.checks ? r.blocks / r.checks : 0, 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
