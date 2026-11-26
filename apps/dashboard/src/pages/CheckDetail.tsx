import { useState } from 'react';
import { Icon } from '../components/Icons.tsx';
import { DiffView, FindingsList, Markdown } from '../components/report.tsx';
import { Card, CopyButton, Empty, ErrorState, Skeleton, Tabs, TimeAgo, VERDICT_ICON, cx } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CheckRecord } from '../lib/api.ts';
import { SOURCE_LABEL, VERDICT_LABEL, dateTime, duration, num, plural } from '../lib/format.ts';
import { navigate, useAsync } from '../lib/hooks.ts';
import { SOURCE_ICON } from './Checks.tsx';

type Tab = 'findings' | 'comment' | 'diff' | 'json';

export function CheckDetailPage({ id }: { id: string }) {
  const d = useAsync(() => api.check(id), [id]);
  const [tab, setTab] = useState<Tab>('findings');

  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  const c = d.data;
  return (
    <div className="fade-in">
      <button className="btn ghost sm" style={{ marginBottom: 14 }} onClick={() => (history.length > 1 ? history.back() : navigate('/checks'))}>
        <Icon name="arrowLeft" size={14} />Back to checks
      </button>
      {!c ? <div className="stack"><Skeleton h={110} /><Skeleton h={320} /></div> : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 1fr) 300px', alignItems: 'start' }}>
          <div className="stack">
            <VerdictHero c={c} />
            <div>
              <Tabs<Tab> value={tab} onChange={setTab} tabs={[
                { value: 'findings', label: 'Findings', icon: 'alert', count: c.findings.length },
                { value: 'comment', label: 'PR comment', icon: 'github' },
                { value: 'diff', label: 'Diff', icon: 'code' },
                { value: 'json', label: 'Report JSON', icon: 'file' },
              ]} />
              {tab === 'findings' && (c.findings.length === 0
                ? <div className="card"><Empty icon="shieldCheck" title="No findings">This change does not touch anything a running experiment depends on.</Empty></div>
                : <FindingsList findings={c.findings} />)}
              {tab === 'comment' && (
                <Card
                  title={<><Icon name="github" size={15} />github-actions commented</>}
                  sub="Posted once and updated in place on every push"
                  actions={<CopyButton text={c.markdown} label="Copy markdown" />}
                >
                  <Markdown source={c.markdown} />
                </Card>
              )}
              {tab === 'diff' && (c.diff ? <DiffView diff={c.diff} findings={c.findings} /> : (
                <div className="card"><Empty icon="code" title="No diff stored">Reports sent from CI include findings but not the full diff.</Empty></div>
              ))}
              {tab === 'json' && (
                <Card title="Check record" actions={<CopyButton text={JSON.stringify(c, null, 2)} label="Copy JSON" />}>
                  <pre className="code" style={{ maxHeight: 560 }}>{JSON.stringify({ ...c, markdown: undefined, diff: undefined }, null, 2)}</pre>
                </Card>
              )}
            </div>
          </div>
          <Sidebar c={c} />
        </div>
      )}
    </div>
  );
}

function VerdictHero({ c }: { c: CheckRecord }) {
  const headline = c.verdict === 'pass'
    ? 'Safe to merge'
    : c.verdict === 'overridden'
      ? 'Merged with an override'
      : c.verdict === 'block'
        ? `${plural(c.counts.block, 'blocking issue')}`
        : `${plural(c.counts.warn, 'warning')}`;
  return (
    <div className={cx('verdict-hero', `v-${c.verdict === 'overridden' ? 'warn' : c.verdict}`)} style={{ color: 'inherit' }}>
      <span className={cx('big', `v-${c.verdict}`)}><Icon name={VERDICT_ICON[c.verdict]} size={24} strokeWidth={2.2} /></span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <span className={cx('chip', `v-${c.verdict}`)}>{VERDICT_LABEL[c.verdict]}</span>
          <span className="faint small">{headline}</span>
        </div>
        <h2 style={{ margin: '6px 0 4px', fontSize: 20, letterSpacing: '-0.02em' }}>{c.pr?.title ?? (c.source === 'mcp' ? 'Coding agent pre-commit check' : 'Local change')}</h2>
        <div className="row wrap small muted" style={{ gap: 8 }}>
          <span className="mono">{c.repo}{c.pr?.number ? ` #${c.pr.number}` : ''}</span>
          {c.pr?.author && <span>· @{c.pr.author}</span>}
          {c.pr?.branch && <span className="row" style={{ gap: 4 }}>· <Icon name="branch" size={13} />{c.pr.branch}</span>}
          <span>· <TimeAgo iso={c.createdAt} /></span>
        </div>
      </div>
      {c.pr?.url && <a className="btn sm" href={c.pr.url} target="_blank" rel="noreferrer"><Icon name="external" size={13} />Open PR</a>}
    </div>
  );
}

function Sidebar({ c }: { c: CheckRecord }) {
  return (
    <div className="stack" style={{ position: 'sticky', top: 84 }}>
      {c.override && (
        <Card title={<><Icon name="unlock" size={15} />Override</>}>
          <div className="small stack" style={{ gap: 6 }}>
            <div><b>@{c.override.by}</b> added <span className="chip mono">{c.override.label}</span></div>
            <div className="muted">{dateTime(c.override.at)}</div>
            <div style={{ color: c.override.accepted ? 'var(--override)' : 'var(--block)' }}>
              {c.override.accepted ? 'Accepted: the label holder has maintain permission.' : `Ignored: ${c.override.reason ?? 'insufficient permission'}.`}
            </div>
          </div>
        </Card>
      )}
      <Card title="Run">
        <dl className="small" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 14px', margin: 0 }}>
          <dt className="faint">Source</dt><dd style={{ margin: 0 }} className="row"><Icon name={SOURCE_ICON[c.source]} size={13} />{SOURCE_LABEL[c.source]}</dd>
          <dt className="faint">When</dt><dd style={{ margin: 0 }}>{dateTime(c.createdAt)}</dd>
          <dt className="faint">Duration</dt><dd style={{ margin: 0 }} className="tnum">{duration(c.durationMs)}</dd>
          <dt className="faint">Files</dt><dd style={{ margin: 0 }} className="tnum">{num(c.stats.filesChanged)} changed · {num(c.stats.filesScanned)} scanned</dd>
          <dt className="faint">Lines</dt><dd style={{ margin: 0 }} className="tnum"><span style={{ color: 'var(--pass)' }}>+{num(c.stats.linesAdded)}</span> <span style={{ color: 'var(--block)' }}>−{num(c.stats.linesRemoved)}</span></dd>
          <dt className="faint">Findings</dt>
          <dd style={{ margin: 0 }} className="row wrap">
            <span className="chip v-block">{c.counts.block} block</span>
            <span className="chip v-warn">{c.counts.warn} warn</span>
            <span className="chip v-info">{c.counts.info} info</span>
            {c.counts.ignored > 0 && <span className="chip">{c.counts.ignored} ignored</span>}
          </dd>
        </dl>
      </Card>
      <Card title="Experiments affected">
        {c.affected.length === 0 ? <div className="small faint">None. This change does not touch any running experiment.</div> : (
          <div className="stack" style={{ gap: 8 }}>
            {c.affected.map(a => (
              <a key={a.id} className="row" href={`#/experiments/${a.id}`} style={{ padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
                <Icon name="flask" size={14} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{a.name}</div>
                  <div className="mono small faint">{a.flagKey}</div>
                </span>
                <Icon name="chevronRight" size={14} />
              </a>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
