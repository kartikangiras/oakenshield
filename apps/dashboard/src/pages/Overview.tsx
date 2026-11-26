import { useMemo, useState } from 'react';
import { AreaChart, ArcGauge, ArmSplit, BarRate, HBars, Legend, SegmentGauge, StackedBars, VERDICT_SERIES } from '../components/charts.tsx';
import type { GaugeSegment } from '../components/charts.tsx';
import { alertTarget } from '../components/alerts.tsx';
import { Icon } from '../components/Icons.tsx';
import { Card, Empty, ErrorState, HeroPortal, Section, Seg, Skeleton, StatusChip, VerdictChip, cx, useCountUp, useToast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CheckSummary, ExperimentView, Overview } from '../lib/api.ts';
import { SOURCE_LABEL, dayLabel, delta, duration, num, pct } from '../lib/format.ts';
import { navigate, useAsync, useLocalStorage } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';
import { SOURCE_ICON } from './Checks.tsx';

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
      <OverviewHero ov={o} range={range} setRange={setRange} hoursPerBlock={settings.data?.hoursPerBlock ?? 6} />
      <LatestAlert />

      <Section
        title="Pull requests"
        sub={`What Experiment Guard decided on every change in the last ${days} days.`}
        actions={(
          <>
            <button className="btn" onClick={() => navigate('/playground?runall=1')}><Icon name="layers" size={14} />Run all scenarios</button>
            <button className="btn primary" onClick={() => navigate('/playground')}><Icon name="play" size={14} />Run a check</button>
          </>
        )}
      >
        <div className="grid split">
          <VerdictsCard ov={o} />
          <LatestChecksCard recent={recent.data?.items} />
        </div>
        <VerdictChart ov={o} />
      </Section>

      <Section title="Trends" sub="How often changes get blocked, how often maintainers override, and how many merge cleanly.">
        <div className="grid cols-3">
          <BlockRateCard ov={o} />
          <OverrideCard ov={o} />
          <CleanMergesCard ov={o} />
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
    <div className={cx('alert-strip', 'fade-in', `sev-${a.severity}`)} style={{ margin: '20px 0 0' }} onClick={() => target && navigate(target)}>
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

/* ---------- hero ---------- */

function OverviewHero({ ov, range, setRange, hoursPerBlock }: { ov: Overview | undefined; range: Range; setRange: (r: Range) => void; hoursPerBlock: number }) {
  const k = ov?.kpis;
  const hours = Math.round(useCountUp(k?.hoursSaved ?? 0, 900));
  // With nothing in the previous period there is no percentage to show, only that it is new.
  const dChecks = k && k.checksPrev > 0 ? delta(k.checks, k.checksPrev) : null;
  const dBlocks = k && k.blocksPrev > 0 ? delta(k.blocks, k.blocksPrev) : null;
  const sign = (d: { pct: number; dir: string } | null) => (!d ? '' : d.dir === 'flat' ? '±0%' : `${d.dir === 'up' ? '+' : '−'}${(Math.abs(d.pct) * 100).toFixed(0)}%`);
  return (
    <HeroPortal>
      <div className="hero-body tall fade-in">
        <div>
          <div className="hero-label">
            Analyst hours saved
            {ov?.mode === 'demo' && <a href="#/integrations" className="chip" title="Connect Flagsmith in Integrations">Demo data</a>}
          </div>
          <div className="hero-number">{k ? <>{num(hours)}<span className="fade"> hours</span></> : <span className="fade">—</span>}</div>
          <div className="row wrap" style={{ gap: 12 }}>
            <Seg<Range> value={range} onChange={setRange} options={[{ value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '90', label: '90 days' }]} />
            <span className="faint small">{k ? `${num(k.blocks)} corrupted experiments avoided × ${hoursPerBlock} h` : ''}</span>
          </div>
        </div>
        <div className="tiles">
          <div className="glass tile">
            <div className="tile-label">Checks run {dChecks && <span className="tile-delta">{sign(dChecks)}</span>}</div>
            <div className="tile-value">{k ? num(k.checks) : '—'}</div>
          </div>
          <div className="glass tile">
            <div className="tile-label">Merges blocked {dBlocks && <span className="tile-delta">{sign(dBlocks)}</span>}</div>
            <div className="tile-value">{k ? num(k.blocks) : '—'}</div>
          </div>
          <div className="glass tile">
            <div className="tile-label">Clean pass rate</div>
            <div className="tile-value">{k ? pct(k.passRate, 1) : '—'}</div>
          </div>
          <div className="glass tile">
            <div className="tile-label">Median CI check</div>
            <div className="tile-value">{k ? duration(k.medianDurationMs) : '—'}</div>
          </div>
        </div>
      </div>
    </HeroPortal>
  );
}

/* ---------- bento cards ---------- */

function bucketize(ov: Overview) {
  const days = ov.series.length;
  const size = days <= 7 ? 1 : days <= 30 ? 5 : 15;
  const out: Array<{ label: string; value: number; detail: string }> = [];
  for (let i = days % size; i < days; i += size) {
    const chunk = ov.series.slice(Math.max(0, i), i + size);
    const total = chunk.reduce((n, d) => n + d.pass + d.warn + d.block + d.overridden, 0);
    const blocked = chunk.reduce((n, d) => n + d.block + d.overridden, 0);
    const label = dayLabel(chunk[0].date);
    out.push({ label: size === 1 ? label.split(' ')[1] ?? label : label, value: total ? blocked / total : 0, detail: `${label}${size > 1 ? ` – ${dayLabel(chunk[chunk.length - 1].date)}` : ''}: ${blocked} of ${total} checks blocked` });
  }
  return { bars: out.slice(-7), size };
}

function BlockRateCard({ ov }: { ov: Overview | undefined }) {
  const data = ov ? bucketize(ov) : null;
  return (
    <Card className="fill" title="Block rate" sub={data ? (data.size === 1 ? 'Share of checks blocked, per day' : `Share of checks blocked, per ${data.size} days`) : ' '}
      actions={<a className="btn ghost sm" href="#/checks?verdict=block">Blocked<Icon name="chevronRight" size={13} /></a>}>
      {!data ? <Skeleton h={176} /> : (
        <BarRate height={210} bars={data.bars} format={v => `${(v * 100).toFixed(1)}%`} tickFormat={(v, step) => `${(v * 100).toFixed(step < 0.01 ? 1 : 0)}%`} />
      )}
    </Card>
  );
}

function OverrideCard({ ov }: { ov: Overview | undefined }) {
  const blocked = ov ? ov.series.reduce((n, d) => n + d.block + d.overridden, 0) : 0;
  const over = ov ? ov.series.reduce((n, d) => n + d.overridden, 0) : 0;
  const rate = blocked ? over / blocked : 0;
  return (
    <div className="card metric-card">
      <div className="card-head"><div><div className="card-title">Override rate</div><div className="card-sub">Blocks a maintainer chose to merge anyway</div></div></div>
      <div className="metric-figure">
        <div className="big">{ov ? pct(rate, 1) : '—'}</div>
        <div className="small muted">{ov ? `${over} of ${blocked} blocked pull requests` : ''}</div>
      </div>
      <div className="metric-visual">{ov ? <ArcGauge value={rate} label={`Override rate ${pct(rate, 1)}`} /> : null}</div>
    </div>
  );
}

function CleanMergesCard({ ov }: { ov: Overview | undefined }) {
  const values = ov?.series.map(d => d.pass) ?? [];
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <div className="card metric-card">
      <div className="card-head"><div><div className="card-title">Clean merges</div><div className="card-sub">Checks that passed, per day</div></div></div>
      <div className="metric-figure">
        <div className="big">{ov ? num(total) : '—'}</div>
        <div className="small muted">{ov ? `passed in ${ov.rangeDays} days` : ''}</div>
      </div>
      <div className="metric-visual" style={{ borderRadius: '0 0 22px 22px', overflow: 'hidden' }}>
        {ov && <AreaChart values={values} labels={ov.series.map(d => dayLabel(d.date))} height={120} />}
      </div>
    </div>
  );
}

function VerdictsCard({ ov }: { ov: Overview | undefined }) {
  const [active, setActive] = useState<string | null>(null);
  const sums = useMemo(() => {
    const t = { pass: 0, warn: 0, overridden: 0, block: 0 };
    for (const d of ov?.series ?? []) { t.pass += d.pass; t.warn += d.warn; t.overridden += d.overridden; t.block += d.block; }
    return t;
  }, [ov]);
  const total = sums.pass + sums.warn + sums.overridden + sums.block;
  const segs: GaugeSegment[] = [
    { key: 'pass', label: 'Passed', value: sums.pass, c1: 'var(--m-pass)', c2: 'var(--m-pass-2)' },
    { key: 'warn', label: 'Warnings', value: sums.warn, c1: 'var(--m-warn)', c2: 'var(--m-warn-2)' },
    { key: 'overridden', label: 'Overridden', value: sums.overridden, c1: 'var(--m-over)', c2: 'var(--m-over-2)' },
    { key: 'block', label: 'Blocked', value: sums.block, c1: 'var(--m-block)', c2: 'var(--m-block-2)' },
  ];
  return (
    <Card title="Verdicts" sub="Hover a segment to focus it" className="fill">
      {!ov ? <Skeleton h={180} /> : (
        <div className="stack" style={{ gap: 26 }}>
          <div style={{ width: '100%', maxWidth: 320, margin: '6px auto 0' }}>
            <SegmentGauge segments={segs} active={active} onActive={setActive} total={`checks in ${ov.rangeDays} days`} />
          </div>
          <div className="legend-grid">
            {segs.map(sg => (
              <div key={sg.key} className={cx('legend-item', active && active !== sg.key && 'dim')} onMouseEnter={() => setActive(sg.key)} onMouseLeave={() => setActive(null)}>
                <i style={{ background: sg.c2 }} />{sg.label}
                <b>{num(sg.value)} <span>({total ? ((sg.value / total) * 100).toFixed(1) : '0.0'}%)</span></b>
              </div>
            ))}
          </div>
        </div>
      )}
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
      <div className="stack" style={{ gap: 3, alignItems: 'flex-end' }}>
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
  if (!exps) return <div className="grid cols-3">{[0, 1, 2].map(i => <Skeleton key={i} h={300} style={{ borderRadius: 22 }} />)}</div>;
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
            {e.hypothesis && <div className="small muted clamp-2" style={{ marginTop: 6 }}>{e.hypothesis}</div>}
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
            <span className="row" style={{ gap: 6 }}>
              <span className="chip v-block" title="Blocked pull requests"><Icon name="octagon" size={11} />{e.blocks}</span>
              <span className="chip v-warn" title="Warnings"><Icon name="alert" size={11} />{e.warns}</span>
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- lower rows ---------- */

function VerdictChart({ ov }: { ov: Overview | undefined }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const sums = VERDICT_SERIES.map(s => ({ ...s, total: ov?.series.reduce((n, d) => n + d[s.key], 0) ?? 0 }));
  return (
    <Card
      title="Checks by verdict"
      sub="Every pull request, CLI and agent check, per day"
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
        <div className="small faint" style={{ marginTop: 10 }}>
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
      <div style={{ marginTop: 10 }}>
        <table className="table">
          <thead><tr><th>Repository</th><th style={{ width: '40%' }}>Checks</th><th style={{ textAlign: 'right' }}>Blocked</th><th style={{ textAlign: 'right' }}>Block rate</th></tr></thead>
          <tbody>
            {ov.byRepo.map(r => (
              <tr key={r.repo} onClick={() => navigate(`/checks?repo=${encodeURIComponent(r.repo)}`)}>
                <td><span className="row"><Icon name="branch" size={14} /><span className="mono">{r.repo}</span></span></td>
                <td>
                  <div className="row">
                    <div className="hbar-track" style={{ flex: 1 }}><div className="hbar-fill" style={{ width: `${(r.checks / max) * 100}%`, background: 'linear-gradient(90deg, var(--m-brand), var(--m-brand-2))' }} /></div>
                    <span className="tnum small" style={{ width: 36, textAlign: 'right' }}>{num(r.checks)}</span>
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
