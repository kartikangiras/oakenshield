import { useMemo, useState } from 'react';
import { AlertRow } from '../components/alerts.tsx';
import { ArmSplit } from '../components/charts.tsx';
import { Icon } from '../components/Icons.tsx';
import type { IconName } from '../components/Icons.tsx';
import { Card, Drawer, Empty, ErrorState, PageHead, Seg, Skeleton, StatusChip, Tabs, TimeAgo, VerdictChip, cx, useToast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CodeReference, ExperimentStatus, ExperimentView } from '../lib/api.ts';
import { dateShort, num, pct } from '../lib/format.ts';
import { navigate, useAsync } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';

type Filter = 'all' | ExperimentStatus;

const REF_META: Record<CodeReference['kind'], { label: string; icon: IconName; tone: string }> = {
  exposure: { label: 'Exposure', icon: 'eye', tone: 'v-brand' },
  variant: { label: 'Variant branch', icon: 'branch', tone: 'v-overridden' },
  conversion: { label: 'Conversion event', icon: 'target', tone: 'v-pass' },
  reference: { label: 'Reference', icon: 'code', tone: '' },
};

export function ExperimentsPage({ selected }: { selected?: string }) {
  const { tick, refreshHealth } = useLive();
  const list = useAsync(() => api.experiments(), [tick]);
  const [filter, setFilter] = useState<Filter>('all');
  const [refreshing, setRefreshing] = useState(false);
  const toast = useToast();

  const order: Record<ExperimentStatus, number> = { running: 0, paused: 1, draft: 2, ended: 3 };
  const items = useMemo(
    () => (list.data ?? []).filter(e => filter === 'all' || e.status === filter).sort((a, b) => order[a.status] - order[b.status] || b.checks - a.checks),
    [list.data, filter], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const count = (s: ExperimentStatus) => (list.data ?? []).filter(e => e.status === s).length;

  const refresh = async () => {
    setRefreshing(true);
    try {
      const f = await api.refreshExperiments();
      refreshHealth();
      list.reload();
      toast({ kind: 'pass', title: 'Snapshot refreshed', body: `${f.running} running experiment${f.running === 1 ? '' : 's'} from ${f.source}` });
    } catch (e) {
      toast({ kind: 'block', title: 'Could not refresh', body: (e as Error).message });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="fade-in">
      <PageHead
        title="Experiments"
        sub="Every Flagsmith experiment Experiment Guard knows about, and the code each one depends on."
        actions={(
          <>
            <Seg<Filter> value={filter} onChange={setFilter} options={[
              { value: 'all', label: <>All <span className="faint">{list.data?.length ?? ''}</span></> },
              { value: 'running', label: <>Running <span className="faint">{count('running')}</span></> },
              { value: 'draft', label: 'Draft' },
              { value: 'ended', label: 'Ended' },
            ]} />
            <button className="btn" onClick={refresh} disabled={refreshing}>
              <Icon name="refresh" size={14} style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined} />Refresh from Flagsmith
            </button>
          </>
        )}
      />
      {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? (
        <div className="grid cols-3">{[0, 1, 2].map(i => <Skeleton key={i} h={260} style={{ borderRadius: 16 }} />)}</div>
      ) : items.length === 0 ? (
        <div className="card"><Empty icon="flask" title="No experiments here">Create one in Flagsmith, or switch the filter.</Empty></div>
      ) : (
        <div className="grid cols-3">
          {items.map(e => <ExperimentCard key={e.id} e={e} />)}
        </div>
      )}
      <Drawer open={!!selected} onClose={() => navigate('/experiments')}>
        {selected && <ExperimentDetail id={selected} />}
      </Drawer>
    </div>
  );
}

function ExperimentCard({ e }: { e: ExperimentView }) {
  const muted = e.status !== 'running';
  return (
    <div className="card exp-card" style={muted ? { opacity: 0.8 } : undefined} onClick={() => navigate(`/experiments/${e.id}`)}>
      <div className="exp-body">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <StatusChip status={e.status} />
        <span className="chip mono">{e.flagKey}</span>
      </div>
      <div>
        <div className="exp-name">{e.name}</div>
        {e.hypothesis && <div className="small muted" style={{ marginTop: 4, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.hypothesis}</div>}
      </div>
      {e.arms && e.arms.length > 0 ? <ArmSplit arms={e.arms} /> : (
        <div className="row wrap" style={{ gap: 6 }}>
          {['control', ...e.variationKeys].map(k => <span key={k} className="chip mono">{k}</span>)}
        </div>
      )}
      <div className="stat-row">
        <div className="stat"><b>{num(e.checks)}</b><span>checks</span></div>
        <div className="stat"><b style={{ color: e.blocks ? 'var(--block)' : undefined }}>{num(e.blocks)}</b><span>blocked</span></div>
        <div className="stat"><b>{e.references.length}</b><span>code refs</span></div>
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {e.metricEvents.map(m => <span key={m} className="chip mono v-pass"><Icon name="target" size={11} />{m}</span>)}
        {e.health?.srmWarning && <span className="chip v-warn"><Icon name="alert" size={11} />Sample ratio mismatch</span>}
      </div>
      <div className="row small faint" style={{ justifyContent: 'space-between', marginTop: 'auto' }}>
        <span>{e.repo ?? 'any repository'}</span>
        {e.lastCheck ? <span className="row" style={{ gap: 6 }}><VerdictChip verdict={e.lastCheck.verdict} compact /><TimeAgo iso={e.lastCheck.at} /></span> : <span>no checks yet</span>}
      </div>
      </div>
    </div>
  );
}

function FlagsmithActivity({ id }: { id: string | number }) {
  const { tick } = useLive();
  const list = useAsync(() => api.alerts(id), [id, tick]);
  return (
    <div>
      <div className="section-title">Changes in Flagsmith while it runs</div>
      {!list.data ? <Skeleton h={48} /> : list.data.length === 0 ? (
        <div className="faint small">No flag, segment or schedule changes received for this experiment.</div>
      ) : (
        <Card pad={false} style={{ boxShadow: 'none' }}>
          <div className="feed">{list.data.slice(0, 8).map(a => <AlertRow key={a.id} a={a} compact />)}</div>
        </Card>
      )}
    </div>
  );
}

type DrawerTab = 'overview' | 'code' | 'activity';

function ExperimentDetail({ id }: { id: string }) {
  const { tick } = useLive();
  const [tab, setTab] = useState<DrawerTab>('overview');
  const d = useAsync(() => api.experiment(id), [id, tick]);
  if (d.error) return <div className="drawer-body"><ErrorState error={d.error} /></div>;
  const e = d.data;
  if (!e) return <div className="drawer-body"><Skeleton h={28} w="60%" /><Skeleton h={120} /><Skeleton h={200} /></div>;

  const total = (e.arms ?? []).reduce((n, a) => n + a.identities, 0);
  const groups = (['exposure', 'variant', 'conversion', 'reference'] as const)
    .map(k => ({ kind: k, refs: e.references.filter(r => r.kind === k) }))
    .filter(g => g.refs.length > 0);

  return (
    <>
      <div className="drawer-head">
        <span className="feed-badge v-brand" style={{ width: 40, height: 40, borderRadius: 12 }}><Icon name="flask" size={19} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <h2 style={{ margin: 0, fontSize: 19, letterSpacing: '-0.02em' }}>{e.name}</h2>
            <StatusChip status={e.status} />
          </div>
          <div className="row wrap small faint" style={{ marginTop: 6, gap: 8 }}>
            <span className="chip mono">{e.flagKey}</span>
            <span>{e.environmentKey}</span>
            {e.startedAt && <span>· started {dateShort(e.startedAt)}</span>}
            {e.endsAt && <span>· ends {dateShort(e.endsAt)}</span>}
          </div>
        </div>
        {e.dashboardUrl && <a className="btn sm" href={e.dashboardUrl} target="_blank" rel="noreferrer"><Icon name="external" size={13} />Flagsmith</a>}
        <button className="btn ghost icon sm" onClick={() => navigate('/experiments')} aria-label="Close"><Icon name="x" /></button>
      </div>
      <div style={{ padding: '14px 24px 0' }}>
        <Tabs<DrawerTab> value={tab} onChange={setTab} tabs={[
          { value: 'overview', label: 'Overview', icon: 'flask' },
          { value: 'code', label: 'Protected code', icon: 'code', count: e.references.length },
          { value: 'activity', label: 'Activity', icon: 'activity' },
        ]} />
      </div>
      <div className="drawer-body" style={{ paddingTop: 8 }}>
        {tab === 'overview' && (<>
        {e.hypothesis && (
          <div>
            <div className="section-title">Hypothesis</div>
            <div className="muted">{e.hypothesis}</div>
          </div>
        )}

        {e.audience && e.audience.length > 0 && (
          <div>
            <div className="section-title">Audience</div>
            <div className="stack" style={{ gap: 8 }}>
              {e.audience.map(a => (
                <div key={a.id} className="row wrap" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 6, fontWeight: 500 }}><Icon name="users" size={14} />{a.name}</span>
                  <span className="faint small">matches on</span>
                  {a.traits.map(t => <span key={t} className="chip mono">{t}</span>)}
                </div>
              ))}
              <div className="small faint">Experiment Guard blocks pull requests that stop sending these traits, and warns when their values change.</div>
            </div>
          </div>
        )}

        <div>
          <div className="section-title">Arms</div>
          {e.arms && e.arms.length > 0 ? (
            <div className="stack" style={{ gap: 12 }}>
              <ArmSplit arms={e.arms} />
              <table className="table" style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
                <thead>
                  <tr><th>Arm</th><th style={{ textAlign: 'right' }}>Identities</th>{e.metricEvents.map(m => <th key={m} style={{ textAlign: 'right' }} className="mono">{m}</th>)}</tr>
                </thead>
                <tbody>
                  {e.arms.map(a => (
                    <tr key={a.key} style={{ cursor: 'default' }}>
                      <td className="mono">{a.key}</td>
                      <td className="tnum" style={{ textAlign: 'right' }}>{num(a.identities)} <span className="faint">({pct(total ? a.identities / total : 0)})</span></td>
                      {e.metricEvents.map(m => {
                        const c = a.conversions?.[m];
                        return <td key={m} className="tnum" style={{ textAlign: 'right' }}>{c === undefined ? '—' : <>{num(c)} <span className="faint">({pct(a.identities ? c / a.identities : 0, 1)})</span></>}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {e.health?.srmWarning && (
                <div className="row small" style={{ color: 'var(--warn)', alignItems: 'flex-start' }}>
                  <Icon name="alert" size={14} style={{ marginTop: 2 }} />
                  Flagsmith reports a sample ratio mismatch. A code path may be exposing one arm more often than the other.
                </div>
              )}
            </div>
          ) : (
            <div className="row wrap" style={{ gap: 6 }}>{['control', ...e.variationKeys].map(k => <span key={k} className="chip mono">{k}</span>)}</div>
          )}
        </div>

        </>)}

        {tab === 'code' && (
        <div>
          <div className="section-title">What Experiment Guard protects</div>
          {groups.length === 0 ? <div className="faint small">No references found in the scanned repository yet.</div> : (
            <div className="stack" style={{ gap: 14 }}>
              {groups.map(g => (
                <div key={g.kind}>
                  <div className="row small" style={{ marginBottom: 4, fontWeight: 600 }}>
                    <span className={cx('chip', REF_META[g.kind].tone)}><Icon name={REF_META[g.kind].icon} size={11} />{REF_META[g.kind].label}</span>
                    <span className="faint">{g.refs.length}</span>
                  </div>
                  {g.refs.map(r => (
                    <div key={`${r.path}:${r.line}`} className="ref">
                      <Icon name="file" size={14} style={{ color: 'var(--text-3)', marginTop: 3 }} />
                      <div style={{ minWidth: 0 }}>
                        <div className="ref-path">{r.path}:{r.line}</div>
                        <div className="ref-code">{r.text.trim()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        )}

        {tab === 'activity' && (<>
        <FlagsmithActivity id={e.id} />

        <div>
          <div className="section-title">Recent checks that touched it</div>
          {e.recentChecks.length === 0 ? <div className="faint small">None yet.</div> : (
            <Card pad={false} style={{ boxShadow: 'none' }}>
              <div className="feed">
                {e.recentChecks.slice(0, 10).map(c => (
                  <div key={c.id} className="feed-item" style={{ gridTemplateColumns: 'auto minmax(0,1fr) auto' }} onClick={() => navigate(`/checks/${c.id}`)}>
                    <VerdictChip verdict={c.verdict} compact />
                    <div style={{ minWidth: 0 }}>
                      <div className="feed-title">{c.pr?.title ?? c.repo}</div>
                      <div className="feed-detail">{c.repo}{c.pr?.number ? ` #${c.pr.number}` : ''} · {c.rules.join(', ') || 'no findings'}</div>
                    </div>
                    <TimeAgo iso={c.createdAt} className="small faint" />
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
        </>)}
      </div>
    </>
  );
}
