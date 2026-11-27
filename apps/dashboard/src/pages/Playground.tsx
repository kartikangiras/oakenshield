import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icons.tsx';
import { DiffView, FindingsList, Markdown } from '../components/report.tsx';
import { Card, Empty, ErrorState, PageHead, Seg, Skeleton, Tabs, VERDICT_ICON, VerdictChip, cx, useToast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { trackEvent } from '../lib/experiments.ts';
import type { CheckRecord, ScenarioView } from '../lib/api.ts';
import { VERDICT_LABEL, duration, plural } from '../lib/format.ts';
import { navigate, setQuery, useAsync, useRoute } from '../lib/hooks.ts';

type Mode = 'scenarios' | 'paste';
type ResultTab = 'findings' | 'comment';

const SAMPLE = `--- a/src/mentors/MentorCard.tsx
+++ b/src/mentors/MentorCard.tsx
@@ -46,7 +46,7 @@ export function MentorCard({ mentor }: Props) {
   const request = () => {
-    flagsmith.trackEvent('mentor_requested');
+    flagsmith.trackEvent('mentorRequested');
     router.push(\`/mentors/\${mentor.id}/request\`);
   };
`;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** The pull request the guided first screen shows (?guided=1, where demo_start's try_it arm lands). */
const FEATURED = 'rename-event';

interface MatrixRow { s: ScenarioView; got?: CheckRecord; error?: string }

export function PlaygroundPage() {
  const { query } = useRoute();
  const scenarios = useAsync(() => api.scenarios(), []);
  const [mode, setMode] = useState<Mode>('scenarios');
  const selectedId = query.get('scenario') ?? undefined;
  const [paste, setPaste] = useState(SAMPLE);
  const [title, setTitle] = useState('Rename mentor_requested event');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckRecord>();
  const [error, setError] = useState<string>();
  const [matrix, setMatrix] = useState<MatrixRow[] | null>(null);
  const toast = useToast();

  // The guided first screen: one broken pull request and a single action. Visitors in the try_it
  // arm of the demo_start A/B test land here (docs/experiment.md); it is also a shareable link.
  const guided = query.get('guided') === '1';

  const list = scenarios.data ?? [];
  const featured = list.find(s => s.id === FEATURED) ?? list[0];
  const selected = guided ? featured : list.find(s => s.id === selectedId) ?? list[0];
  useEffect(() => { setResult(undefined); setError(undefined); }, [selected?.id, mode, guided]);

  const run = async () => {
    trackEvent('check_run');
    setRunning(true);
    setError(undefined);
    setResult(undefined);
    try {
      const [r] = await Promise.all([
        mode === 'scenarios' && selected ? api.runScenario(selected.id) : api.runDiff(paste, title || 'Pasted diff'),
        sleep(650), // long enough to see the scan; the engine itself takes a few ms
      ]);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const runAll = async () => {
    trackEvent('check_run');
    const rows: MatrixRow[] = list.map(s => ({ s }));
    setMatrix(rows);
    for (let i = 0; i < rows.length; i++) {
      try {
        rows[i] = { ...rows[i], got: await api.runScenario(rows[i].s.id) };
      } catch (e) {
        rows[i] = { ...rows[i], error: (e as Error).message };
      }
      setMatrix([...rows]);
      await sleep(60);
    }
    const ok = rows.filter(r => r.got && matches(r.s, r.got)).length;
    toast({ kind: ok === rows.length ? 'pass' : 'warn', title: `${ok} of ${rows.length} scenarios match`, body: ok === rows.length ? 'Every seeded scenario got the expected verdict and rules.' : 'Open the matrix to see which ones differ.' });
  };

  // Deep link from the overview: #/playground?runall=1 runs the whole matrix once.
  const autoRan = useRef(false);
  useEffect(() => {
    if (query.get('runall') === '1' && list.length && !autoRan.current) {
      autoRan.current = true;
      setQuery({ runall: undefined });
      void runAll();
    }
  }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const caught = list.filter(s => !s.negative);
  const clean = list.filter(s => s.negative);

  return (
    <div className="fade-in">
      <PageHead
        title="Playground"
        sub="Run Experiment Guard against seeded pull requests on the FirstPR demo app, or paste any unified diff."
        actions={guided ? undefined : <button className="btn" onClick={runAll} disabled={!list.length || (matrix !== null && matrix.some(r => !r.got && !r.error))}><Icon name="layers" size={14} />Run all {list.length || ''} scenarios</button>}
      />
      {scenarios.error ? <ErrorState error={scenarios.error} onRetry={scenarios.reload} /> : guided ? (
        <Guided
          s={featured} total={list.length} running={running} result={result} error={error}
          onRun={run} onBrowse={() => { setMode('scenarios'); setQuery({ guided: undefined }); }}
        />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: '340px minmax(0, 1fr)', alignItems: 'start' }}>
          <div className="card" style={{ position: 'sticky', top: 84, maxHeight: 'calc(100vh - 110px)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
              <Seg<Mode> value={mode} onChange={setMode} className="full" options={[
                { value: 'scenarios', label: <><Icon name="layers" size={13} />Scenarios</> },
                { value: 'paste', label: <><Icon name="code" size={13} />Paste a diff</> },
              ]} />
            </div>
            {mode === 'scenarios' ? (
              <div style={{ overflow: 'auto', padding: 8 }}>
                {!scenarios.data ? <div className="stack" style={{ padding: 8 }}>{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} h={44} />)}</div> : (
                  <>
                    <div className="palette-group">Should be caught · {caught.length}</div>
                    {caught.map(s => <ScenarioItem key={s.id} s={s} on={s.id === selected?.id} />)}
                    <div className="palette-group" style={{ marginTop: 8 }}>Should pass quietly · {clean.length}</div>
                    {clean.map(s => <ScenarioItem key={s.id} s={s} on={s.id === selected?.id} />)}
                  </>
                )}
              </div>
            ) : (
              <div className="stack" style={{ padding: 16, gap: 12 }}>
                <label className="small muted">Title
                  <input className="input" style={{ width: '100%', marginTop: 4 }} value={title} onChange={e => setTitle(e.target.value)} />
                </label>
                <div className="small muted">The diff is checked against the experiments running right now, with your rule settings. Only the diff is scanned, so cross-file rules such as EG001 search the pasted lines alone.</div>
              </div>
            )}
          </div>

          <div className="stack">
            {matrix && <Matrix rows={matrix} onClose={() => setMatrix(null)} />}
            {mode === 'scenarios' && selected && (
              <Card
                title={<><Icon name="pr" size={15} />{selected.title}</>}
                sub={selected.description}
                actions={<RunButton running={running} onClick={run} />}
              >
                <div className="row wrap small" style={{ gap: 8, marginBottom: 12 }}>
                  <span className="faint">Expected</span>
                  <VerdictChip verdict={selected.expect.verdict} />
                  {selected.expect.rules.map(r => <span key={r} className="chip mono">{r}</span>)}
                  {selected.author && <span className="faint">· a pull request by @{selected.author}</span>}
                </div>
                <div className={cx(running && 'scan')} style={{ borderRadius: 12 }}>
                  <DiffView diff={selected.diff} findings={result?.findings} />
                </div>
              </Card>
            )}
            {mode === 'paste' && (
              <Card title={<><Icon name="code" size={15} />Unified diff</>} sub="Output of git diff, or a .diff / .patch file" actions={<RunButton running={running} onClick={run} disabled={!paste.trim()} />}>
                <textarea className={cx('input', running && 'scan')} rows={16} style={{ width: '100%' }} spellCheck={false} value={paste} onChange={e => setPaste(e.target.value)} />
              </Card>
            )}
            {error && <div className="card fade-in"><Empty icon="alert" title="The check did not run">{error}</Empty></div>}
            {result && <Result r={result} expected={mode === 'scenarios' ? selected : undefined} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** One broken pull request and a single action: the first screen of demo_start's try_it arm. */
function Guided({ s, total, running, result, error, onRun, onBrowse }: {
  s?: ScenarioView; total: number; running: boolean; result?: CheckRecord; error?: string; onRun: () => void; onBrowse: () => void;
}) {
  if (!s) return <div className="stack"><Skeleton h={120} /><Skeleton h={260} /></div>;
  return (
    <div className="stack guided">
      <Card
        title={<><Icon name="pr" size={15} />{s.title}</>}
        sub={<>A contributor opened this pull request while an experiment is counting the event it renames. Would you merge it? Run Experiment Guard to see what it finds.</>}
        actions={<RunButton running={running} onClick={onRun} />}
      >
        <div className={cx(running && 'scan')} style={{ borderRadius: 12 }}>
          <DiffView diff={s.diff} findings={result?.findings} />
        </div>
        <div className="row wrap small muted" style={{ gap: 8, marginTop: 16 }}>
          <span>Want more?</span>
          <button type="button" className="btn ghost sm" onClick={onBrowse}><Icon name="layers" size={13} />Browse all {total} scenarios or paste your own diff</button>
        </div>
      </Card>
      {error && <div className="card fade-in"><Empty icon="alert" title="The check did not run">{error}</Empty></div>}
      {result && <Result r={result} expected={s} />}
    </div>
  );
}

function matches(s: ScenarioView, got: CheckRecord) {
  const rules = [...new Set(got.findings.filter(f => !f.ignoredBecause).map(f => f.rule))].sort();
  return got.verdict === s.expect.verdict && s.expect.rules.every(r => rules.includes(r));
}

function ScenarioItem({ s, on }: { s: ScenarioView; on: boolean }) {
  return (
    <div className={cx('scenario', on && 'on')} onClick={() => setQuery({ scenario: s.id })}>
      <span className="scenario-title">{s.title}</span>
      <span className="row" style={{ gap: 4 }}>
        {s.expect.rules[0] && <span className="chip mono" style={{ height: 20, fontSize: 12 }}>{s.expect.rules[0]}</span>}
        <VerdictChip verdict={s.expect.verdict} compact />
      </span>
      <span className="scenario-desc">{s.description}</span>
    </div>
  );
}

export function RunButton({ running, onClick, disabled, label = 'Run Experiment Guard' }: { running: boolean; onClick: () => void; disabled?: boolean; label?: string }) {
  return (
    <button className="btn primary" onClick={onClick} disabled={running || disabled}>
      <Icon name={running ? 'refresh' : 'shieldCheck'} size={15} style={running ? { animation: 'spin 0.9s linear infinite' } : undefined} />
      {running ? 'Scanning…' : label}
    </button>
  );
}

export function Result({ r, expected }: { r: CheckRecord; expected?: ScenarioView }) {
  const [tab, setTab] = useState<ResultTab>('findings');
  const ok = expected ? matches(expected, r) : undefined;
  const v = r.verdict === 'overridden' ? 'warn' : r.verdict;
  return (
    <div className="stack fade-in">
      <div className={cx('verdict-hero', `v-${v}`)} style={{ color: 'inherit' }}>
        <span className={cx('big', `v-${r.verdict}`)}><Icon name={VERDICT_ICON[r.verdict]} size={24} strokeWidth={2.2} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '-0.02em' }}>
            {r.verdict === 'block' ? `Merge blocked: ${plural(r.counts.block, 'blocking issue')}` : r.verdict === 'warn' ? `Mergeable, with ${plural(r.counts.warn, 'warning')}` : 'Safe to merge'}
          </div>
          <div className="small muted">
            {r.affected.length ? `Touches ${r.affected.map(a => a.name).join(', ')}` : 'Touches no running experiment'} · scanned {plural(r.stats.filesScanned, 'file')} in {duration(r.durationMs)}
          </div>
        </div>
        {ok !== undefined && (
          <span className={cx('chip', ok ? 'v-pass' : 'v-warn')} style={{ height: 26 }}>
            <Icon name={ok ? 'check' : 'alert'} size={13} />{ok ? 'Matches expected' : `Expected ${VERDICT_LABEL[expected!.expect.verdict].toLowerCase()}`}
          </span>
        )}
        <button className="btn sm" onClick={() => navigate(`/checks/${r.id}`)}>Open check<Icon name="chevronRight" size={13} /></button>
      </div>
      <div>
        <Tabs<ResultTab> value={tab} onChange={setTab} tabs={[
          { value: 'findings', label: 'Findings', icon: 'alert', count: r.findings.length },
          { value: 'comment', label: 'PR comment preview', icon: 'github' },
        ]} />
        {tab === 'findings' ? (r.findings.length ? <FindingsList findings={r.findings} /> : <div className="card"><Empty icon="shieldCheck" title="Nothing to report">No running experiment depends on the lines this change touches.</Empty></div>)
          : <Card><Markdown source={r.markdown} /></Card>}
      </div>
    </div>
  );
}

function Matrix({ rows, onClose }: { rows: MatrixRow[]; onClose: () => void }) {
  const done = rows.filter(r => r.got || r.error).length;
  const ok = rows.filter(r => r.got && matches(r.s, r.got)).length;
  return (
    <Card
      title={<><Icon name="layers" size={15} />Scenario matrix</>}
      sub={done < rows.length ? `Running ${done + 1} of ${rows.length}…` : `${ok} of ${rows.length} match the expected verdict and rules`}
      actions={<button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><Icon name="x" /></button>}
      pad={false}
    >
      <div style={{ height: 3, background: 'var(--surface-3)', margin: '12px 24px 0', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${(done / rows.length) * 100}%`, background: 'var(--brand-1)', transition: 'width 400ms cubic-bezier(0.32, 0.72, 0, 1)' }} />
      </div>
      <div className="matrix" style={{ marginTop: 8 }}>
        <div className="faint small" style={{ fontWeight: 600 }}>Scenario</div><div className="faint small" style={{ fontWeight: 600 }}>Expected</div><div className="faint small" style={{ fontWeight: 600 }}>Actual</div><div />
        {rows.map(r => {
          const good = r.got ? matches(r.s, r.got) : undefined;
          return (
            <div key={r.s.id} className="mrow" onClick={() => r.got && navigate(`/checks/${r.got.id}`)}>
              <div style={{ minWidth: 0 }}><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.s.title}</span></div>
              <div><VerdictChip verdict={r.s.expect.verdict} compact />{r.s.expect.rules[0] && <span className="mono small faint" style={{ marginLeft: 8 }}>{r.s.expect.rules[0]}</span>}</div>
              <div>{r.got ? <><VerdictChip verdict={r.got.verdict} compact /><span className="mono small faint" style={{ marginLeft: 8 }}>{r.got.findings[0]?.rule ?? ''}</span></> : r.error ? <span className="chip v-block">error</span> : <span className="skeleton" style={{ width: 50, height: 20 }} />}</div>
              <div>{good === undefined ? null : <Icon name={good ? 'check' : 'x'} size={16} strokeWidth={2.4} style={{ color: good ? 'var(--pass)' : 'var(--block)' }} />}</div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
