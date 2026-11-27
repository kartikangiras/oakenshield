import { useEffect, useState } from 'react';
import { Icon } from '../components/Icons.tsx';
import type { IconName } from '../components/Icons.tsx';
import { Empty, ErrorState, PageHead, Seg, Skeleton, TimeAgo, VerdictChip } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CheckSource, CheckSummary, Verdict } from '../lib/api.ts';
import { SOURCE_LABEL, num } from '../lib/format.ts';
import { navigate, setQuery, useAsync, useDebounced, useRoute } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';

const PAGE = 50;
export const SOURCE_ICON: Record<CheckSource, IconName> = { ci: 'github', cli: 'terminal', mcp: 'bot', playground: 'play', api: 'plug', webhook: 'refresh' };

export function ChecksPage() {
  const { query } = useRoute();
  const { tick } = useLive();
  const verdict = (query.get('verdict') ?? 'all') as Verdict | 'all';
  // Set by the Rules page: the checks one rule fired on.
  const rule = query.get('rule') ?? '';
  const [text, setText] = useState(query.get('q') ?? '');
  const q = useDebounced(text, 250);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => { setQuery({ q: q || undefined }); }, [q]);
  useEffect(() => setLimit(PAGE), [verdict, rule, q]);

  const page = useAsync(() => api.checks({ verdict, rule: rule || undefined, q, limit }), [verdict, rule, q, limit, tick]);
  const items = page.data?.items;

  return (
    <div className="fade-in">
      <PageHead title="Checks" sub="Every Experiment Guard run, newest first: pull requests, the command line, coding agents and the playground." />
      <div className="card" style={{ marginBottom: 16, padding: 12 }}>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="input-icon" style={{ flex: 1, minWidth: 240 }}>
            <Icon name="search" size={15} />
            <input className="input" placeholder="Search by title, author, repository, experiment or rule" aria-label="Search checks" value={text} onChange={e => setText(e.target.value)} />
          </div>
          <Seg<Verdict | 'all'> value={verdict} onChange={v => setQuery({ verdict: v })} options={[
            { value: 'all', label: 'All' },
            { value: 'block', label: <><Icon name="octagon" size={12} />Blocked</>, className: 's-block' },
            { value: 'warn', label: <><Icon name="alert" size={12} />Warning</> },
            { value: 'overridden', label: <><Icon name="unlock" size={12} />Overridden</> },
            { value: 'pass', label: <><Icon name="check" size={12} />Passed</> },
          ]} />
          {rule && <span className="chip mono" title={`Only checks where ${rule} fired`}>{rule}</span>}
          {(verdict !== 'all' || rule || text) && (
            <button className="btn ghost sm" onClick={() => { setText(''); setQuery({ verdict: undefined, rule: undefined, q: undefined }); }}>
              <Icon name="x" size={13} />Clear
            </button>
          )}
        </div>
      </div>

      {page.error && !page.data ? <ErrorState error={page.error} onRetry={page.reload} /> : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {!items ? (
            <div className="card-pad stack">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} h={36} />)}</div>
          ) : items.length === 0 ? (
            <Empty icon="filter" title="No checks match">Try a different filter, or run one in the playground.</Empty>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 120 }}>Verdict</th>
                      <th>Change</th>
                      <th>Findings</th>
                      <th>Experiments</th>
                      <th>Source</th>
                      <th style={{ textAlign: 'right' }}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map(c => <CheckRow key={c.id} c={c} />)}
                  </tbody>
                </table>
              </div>
              <div className="row small faint" style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', justifyContent: 'space-between' }}>
                <span>Showing {num(items.length)} of {num(page.data!.total)}</span>
                {items.length < page.data!.total && (
                  <button className="btn sm" onClick={() => setLimit(l => l + PAGE)} disabled={page.loading}>Load more</button>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CheckRow({ c }: { c: CheckSummary }) {
  return (
    <tr onClick={() => navigate(`/checks/${c.id}`)}>
      <td><VerdictChip verdict={c.verdict} /></td>
      <td style={{ maxWidth: 440 }}>
        <div className="cell-title">{c.pr?.title ?? (c.source === 'mcp' ? 'Coding agent pre-commit check' : 'Local change')}</div>
        <div className="cell-sub">
          <span className="mono">{c.repo}{c.pr?.number ? ` #${c.pr.number}` : ''}</span>
          {c.pr?.author && <> · @{c.pr.author}</>}
          {' · '}{c.stats.filesChanged} file{c.stats.filesChanged === 1 ? '' : 's'}
          {' '}<span style={{ color: 'var(--pass)' }}>+{c.stats.linesAdded}</span>{' '}<span style={{ color: 'var(--block)' }}>−{c.stats.linesRemoved}</span>
        </div>
      </td>
      <td>
        <div className="row wrap" style={{ gap: 4 }}>
          {[...new Set(c.rules)].slice(0, 3).map(r => <span key={r} className="chip mono">{r}</span>)}
          {new Set(c.rules).size > 3 && <span className="faint small">+{new Set(c.rules).size - 3}</span>}
        </div>
      </td>
      <td className="small muted" style={{ maxWidth: 220 }}>
        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.affected.map(a => a.name).join(', ')}</div>
      </td>
      <td className="small muted">
        <span className="row" style={{ gap: 8 }}><Icon name={SOURCE_ICON[c.source]} size={14} />{SOURCE_LABEL[c.source]}</span>
      </td>
      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        <TimeAgo iso={c.createdAt} className="small" />
      </td>
    </tr>
  );
}
