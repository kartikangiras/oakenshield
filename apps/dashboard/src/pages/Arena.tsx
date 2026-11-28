import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { AgentKey } from '../../../../packages/arena/src/agents.ts';
import type { ArenaRecord, Finalist } from '../../../../packages/arena/src/debate.ts';
import type { ArenaState, FeedRow, Totals } from '../../../../packages/arena/src/ledger.ts';
import type { Side, Tape } from '../../../../packages/arena/src/playbook.ts';
import { Legend } from '../components/charts.tsx';
import { Icon } from '../components/Icons.tsx';
import { Card, CodeBlock, Empty, ErrorState, PageHead, Section, Skeleton, cx } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { ArenaCheck, ArenaView } from '../lib/api.ts';
import { breakEven, heartbeat, inWords, named } from '../lib/arena-words.ts';
import { mountDuelViz } from '../lib/duel-viz.ts';
import { num, pct } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';

/* What the flagsmith-duel skill writes beside the plan (skills/flagsmith-duel/scripts/duel.mjs). */
interface Seal {
  experiment: number;
  flag: string;
  environment: { name: string };
  split: Record<string, number>;
  started_at: string | null;
  completed_at?: string;
  decision?: string;
}
interface Row { visitors: number; converted: number; rate: number; chance_to_win?: number }
interface Watched { visitors: number; sum: number; mean: number }
interface Verdict {
  state: 'decided' | 'void';
  winner: string | null;
  why: string;
  read_at: string;
  sample_ratio_p?: number | null;
  rule: { min_per_arm: number; win_above: number; harm_below: number };
  table: Record<string, Record<string, Row | null>>;
  /** Numbers Flagsmith reports next to the goal. No rule reads them. */
  watch?: Record<string, Record<string, Watched | null>>;
  head_to_head?: { between: string[]; p_value: number };
  predictions: Record<string, { by: string; predicted: Record<string, number>; mean_abs_error: number | null }>;
}
type Approvals = Partial<Record<'start' | 'finish', { code: string; at: string; by: string }>>;

const AGENTS: AgentKey[] = ['agent_a', 'agent_b'];
const ARM_COLOR: Record<string, string> = { control: 'var(--text-3)', agent_a: 'var(--accent)', agent_b: 'var(--brand-1)' };
const POLL = 10_000;
const FEED_ROWS = 12;

/** The arena's files are written up in UTC, so the page shows the same clock to everyone. */
const dateTime = (iso: string) =>
  `${new Date(iso).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} UTC`;
const hhmm = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 16);
/** A stake: whole paper dollars. */
const dollars = (v: number) => `$${Number.isInteger(v) ? v : v.toFixed(2)}`;
const money = (v: number) => `${v < 0 ? '−' : v > 0 ? '+' : ''}$${Math.abs(v).toFixed(2)}`;
const tone = (v: number | undefined) => (v === undefined || v === 0 ? undefined : v > 0 ? 'gain' : 'loss');
const chance = (v: number) => (v > 0.999 ? 'Above 99.9%' : v < 0.001 ? 'Below 0.1%' : pct(v, 1));
/** A difference between two shares, in points: +2.6. */
const points = (v: number) => `${v < 0 ? '−' : '+'}${Math.abs(v * 100).toFixed(1)}`;
const clock = (iso: string) => `${iso.slice(11, 16)} UTC`;
const sideName = (s: Side) => (s === 'up' ? 'Up' : 'Down');

function parts(view: ArenaView | null | undefined) {
  const record = (view?.record ?? null) as ArenaRecord | null;
  const sealed = (view?.seal ?? null) as Seal | null;
  // Until a person has started the experiment, anything else in the directory is a rehearsal.
  const seal = sealed?.started_at ? sealed : null;
  const verdict = seal ? (view?.verdict ?? null) as Verdict | null : null;
  return {
    record,
    seal,
    verdict,
    state: seal ? (view?.state ?? null) as ArenaState | null : null,
    approvals: (view?.approvals ?? {}) as Approvals,
    // The second reading is written after the result is read, and shown only beside it.
    check: verdict ? (view?.check ?? null) as ArenaCheck | null : null,
    heard: view?.heard_at ?? null,
    planned: view?.limit ?? null,
  };
}

const armName = (record: ArenaRecord, k: string) => (k === 'control' ? 'Coin' : record.agents[k as AgentKey]?.name ?? k);
/** The contenders first and the control last, the way the lanes are drawn. */
const shown = (order: string[]) => [...order.filter(k => k !== 'control'), ...order.filter(k => k === 'control')];
const armNote = (record: ArenaRecord, k: string) => (k === 'control' ? 'The control' : record.agents[k as AgentKey]?.stance ?? '');
function headline(record: ArenaRecord, seal: Seal | null, verdict: Verdict | null, state: ArenaState | null): { title: string; sub: string } {
  const need = record.brief.rule.min_per_arm;
  if (!seal) return { title: 'Waiting for a person to start it', sub: 'The playbooks and the rule are fixed. Nothing exists in Flagsmith yet, and nothing trades until a person approves the start.' };
  if (!verdict && state?.risk?.halted_at) {
    return { title: 'The loss limit stopped the arena', sub: `Every version stopped at ${clock(state.risk.halted_at)}, so the stop cannot favour one. Nothing trades until a person restarts it.` };
  }
  if (!verdict) {
    const least = state ? Math.min(...state.order.map(k => state.arms[k]?.markets ?? 0)) : 0;
    return { title: 'The arena is running', sub: `Experiment ${seal.experiment} in Flagsmith. The result is read once, when every version has ${need} markets. The slowest has ${num(Math.min(least, need))}.` };
  }
  if (verdict.state === 'void') return { title: 'No verdict: the run is void', sub: named(verdict.why) };
  const agentWon = !!verdict.winner && verdict.winner !== 'control';
  const after = seal.completed_at ? `Rolled out on ${dateTime(seal.completed_at)}.` : 'The rollout waits for a person.';
  return agentWon
    ? { title: `${armName(record, verdict.winner!)} beat the coin`, sub: `Its playbook cleared the rule that was fixed before the start. ${after}` }
    : { title: 'The coin stays', sub: `Neither playbook cleared the rule that was fixed before the start. ${after}` };
}

/* ---------- the lanes: one dot per settled market ---------- */

let replayed = false;

function Lanes({ record, state, verdict }: { record: ArenaRecord; state: ArenaState; verdict: Verdict | null }) {
  const stage = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const settled = state.order.reduce((n, k) => n + (state.arms[k]?.settled ?? 0), 0);
  const winner = verdict?.state === 'decided' && verdict.winner && verdict.winner !== 'control' ? verdict.winner : null;
  const result = verdict?.state === 'decided' ? (winner ? `${armName(record, winner)} wins` : 'The coin stays') : `${num(settled)} markets settled`;

  useEffect(() => {
    if (!stage.current) return;
    const viz = mountDuelViz(stage.current, {
      lanes: state.order.map(k => ({
        key: k,
        label: armName(record, k),
        note: armNote(record, k),
        visitors: state.arms[k]?.settled ?? 0,
        converted: state.arms[k]?.won ?? 0,
      })),
      visits: state.replay,
      baseline: 'control',
      did: 'right call',
      missed: 'Wrong call',
      unit: 'markets',
      winner,
      result,
      status: status.current,
      caption: 'One dot is one market, in the order they settled.',
      autoplay: !replayed,
      delay: 400,
      onPlay: () => { replayed = true; },
    });
    return () => viz.destroy();
    // The page polls; the lanes are drawn again only when a market has settled or the result is in.
  }, [state.replay, result]);

  return (
    <div>
      <div className="arena-stage-head"><span className="section-title">Right calls per version</span><span ref={status} className="chip mono" /></div>
      <div ref={stage} />
    </div>
  );
}

/* ---------- running: the score, the profit and the trades ---------- */

function ArmTile({ record, k, t, need }: { record: ArenaRecord; k: string; t: Totals; need: number }) {
  const even = breakEven(t);
  return (
    <div className="card arena-arm" style={{ '--c': ARM_COLOR[k] ?? 'var(--text-3)' } as CSSProperties}>
      <div className="arena-arm-name"><span className="duel-dot" style={{ background: 'var(--c)' }} />{armName(record, k)}<small>{armNote(record, k)}</small></div>
      <div className="arena-arm-stats">
        <div><span className="small muted">Paper profit</span><b className={cx('tnum', tone(t.profit))}>{money(t.profit)}</b></div>
        <div><span className="small muted">Markets</span><b className="tnum">{num(t.markets)} <small>of {num(need)} needed</small></b></div>
      </div>
      <div className="arena-bar" role="progressbar" aria-label={`${armName(record, k)}: markets so far`} aria-valuemin={0} aria-valuemax={need} aria-valuenow={Math.min(t.markets, need)}>
        <i style={{ width: `${Math.min(1, t.markets / Math.max(1, need)) * 100}%` }} />
      </div>
      {t.settled > 0 && (
        <div className="arena-even small tnum">
          <span>Right calls <b>{pct(t.won / t.settled, 1)}</b></span>
          {even !== null && <span>Break even <b>{pct(even, 1)}</b></span>}
        </div>
      )}
    </div>
  );
}

/* ---------- controls: what limits the run, and what needs a person ---------- */

function Controls({ record, state, planned }: { record: ArenaRecord; state: ArenaState | null; planned: ArenaView['limit'] }) {
  const { brief } = record;
  // The runner publishes the limit with what the last markets lost against it. Before the start there is only the brief.
  const limit = state?.risk ?? planned ?? brief.risk ?? null;
  const lost = state?.risk?.lost;
  const stopped = !!state?.risk?.halted_at;
  return (
    <Section title="Controls" sub="What limits the run while it trades, and what needs a person's yes.">
      <div className="card arena-controls">
        <div className={cx('arena-limit', stopped && 'stopped')}>
          <div className="section-title">Loss limit</div>
          {limit && lost !== undefined && (
            <>
              <div className="arena-limit-n tnum"><b>{dollars(Math.max(0, lost))}</b> of {dollars(limit.max_loss)} lost</div>
              <div className="arena-bar" role="meter" aria-label="Paper dollars lost against the loss limit" aria-valuemin={0} aria-valuemax={limit.max_loss} aria-valuenow={Math.min(limit.max_loss, Math.max(0, lost))}>
                <i style={{ width: `${Math.min(1, Math.max(0, lost) / limit.max_loss) * 100}%` }} />
              </div>
            </>
          )}
          <div className="small muted">
            {limit
              ? `Counted over the last ${num(limit.over)} settled markets, every version together. At ${dollars(limit.max_loss)} of paper money lost every version stops, so the stop cannot favour one.`
              : 'Set in the brief and counted over the latest settled markets, every version together. At the limit every version stops, so the stop cannot favour one.'}
            {lost !== undefined && lost < 0 && ` Right now those markets are ${dollars(-lost)} ahead.`}
          </div>
        </div>
        <dl className="arena-control-list">
          <div><dt>A person approves</dt><dd>The start, a restart after the loss limit stopped the arena, and the rollout. Each is typed in that person's own terminal.</dd></div>
          <div><dt>Sample and rule</dt><dd>{num(brief.rule.min_per_arm)} markets per version and the rule are fixed before the start. The result is read once.</dd></div>
          <div><dt>Every market</dt><dd>Gets {dollars(brief.venue.stake)} of paper money and no more. It is skipped, before any version is asked, when a side costs more than {brief.venue.max_price.toFixed(2)} a share or the order book is too thin.</dd></div>
          <div><dt>One runner</dt><dd>A lock beside the trade log keeps a second runner from trading the same markets twice.</dd></div>
          <div><dt>Pull requests</dt><dd>While the experiment runs, Experiment Guard blocks a pull request that renames the flag or an event in the brief, removes the flag read, or changes a playbook file.</dd></div>
        </dl>
      </div>
    </Section>
  );
}

const W = 1000;
const H = 240;

function Curve({ record, state }: { record: ArenaRecord; state: ArenaState }) {
  const { at, profit } = state.curve;
  const keys = shown(state.order).filter(k => profit[k]?.length);
  if (at.length < 2 || !keys.length) {
    return <Empty icon="chart" title="No curve yet">It is drawn once markets from two five minute windows have settled.</Empty>;
  }
  const all = keys.flatMap(k => profit[k]!);
  const top = Math.max(0, ...all);
  const bottom = Math.min(0, ...all);
  const span = top - bottom || 1;
  const x = (i: number) => (i / (at.length - 1)) * W;
  const y = (v: number) => 8 + ((top - v) / span) * (H - 16);
  const zero = y(0) / H;
  return (
    <div className="arena-chart">
      <div className="arena-plot">
        <span className="arena-axis tnum" style={{ top: 0 }}>{money(top)}</span>
        {zero > 0.15 && zero < 0.85 && <span className="arena-axis mid tnum" style={{ top: `${zero * 100}%` }}>$0</span>}
        <span className="arena-axis tnum" style={{ bottom: 0 }}>{money(bottom)}</span>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Running paper profit per version. ${keys.map(k => `${armName(record, k)} ${money(profit[k]!.at(-1) ?? 0)}`).join(', ')}.`}>
          <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="arena-zero" vectorEffect="non-scaling-stroke" />
          {keys.map(k => (
            <polyline key={k} fill="none" stroke={ARM_COLOR[k] ?? 'var(--text-3)'} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"
              points={profit[k]!.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')} />
          ))}
        </svg>
      </div>
      <div className="arena-times small faint tnum"><span>{hhmm(at[0]!)} UTC</span><span>{hhmm(at.at(-1)!)} UTC</span></div>
      <Legend items={keys.map(k => ({ label: armName(record, k), color: ARM_COLOR[k] ?? 'var(--text-3)', value: money(profit[k]!.at(-1) ?? 0) }))} />
    </div>
  );
}

function Feed({ record, rows }: { record: ArenaRecord; rows: FeedRow[] }) {
  if (!rows.length) return <Empty icon="clock" title="No trades yet">The first calls are made 50 seconds before the next five minute markets open.</Empty>;
  return (
    <div className="arena-scroll">
      <table className="table plain arena-feed">
        <thead>
          <tr><th>Market (UTC)</th><th>Version</th><th>Call</th><th className="num">Price</th><th>Resolved</th><th className="num">Paper profit</th></tr>
        </thead>
        <tbody>
          {rows.slice(0, FEED_ROWS).map(r => (
            <tr key={r.slug}>
              <td><b className="arena-asset">{r.asset.toUpperCase()}</b> <span className="muted tnum">{hhmm(r.start)}</span></td>
              <td><span className="arena-who"><span className="duel-dot" style={{ background: ARM_COLOR[r.arm] ?? 'var(--text-3)' }} />{armName(record, r.arm)}{r.phase === 'after' && <span className="chip">After the experiment</span>}</span></td>
              <td>{sideName(r.side)}</td>
              <td className="num tnum">{r.price.toFixed(2)}</td>
              <td>{r.winner ? sideName(r.winner) : <span className="faint">Open</span>}</td>
              <td className={cx('num tnum', tone(r.profit))}>{r.profit === undefined ? <span className="faint">Waiting</span> : <b>{money(r.profit)}</b>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- decided: Flagsmith's numbers ---------- */

/** The arena's own reading of its trade log, beside Flagsmith's numbers. Flagsmith's rule decides. */
function Second({ record, check, rule }: { record: ArenaRecord; check: ArenaCheck; rule: Verdict['rule'] }) {
  const arms = ['control', ...AGENTS].filter(k => check.arms[k]);
  const clears = (v: number | null | undefined) => typeof v === 'number' && v > rule.win_above;
  const compared = AGENTS.filter(k => check.against_control[k] && typeof check.flagsmith[k] === 'number');
  const apart = compared.filter(k => clears(check.against_control[k]!.chance_to_win) !== clears(check.flagsmith[k]));
  return (
    <div className="arena-second stack">
      <div>
        <div className="section-title">A second reading, by five minute window</div>
        <div className="small muted">
          Markets that open in the same five minutes move together, so they are not as independent as visitors are. This reading draws whole windows from the runner's own trade log.
          Flagsmith's numbers and the rule decide. This is a check beside them.
        </div>
      </div>
      <div className="arena-scroll">
        <table className="table plain">
          <thead>
            <tr><th>The runner's trade log</th><th className="num">Right calls</th><th className="num">Break even</th><th className="num">Against the coin, in points</th><th className="num">Chance to beat the coin, by window</th><th className="num">Flagsmith's</th></tr>
          </thead>
          <tbody>
            {arms.map(k => {
              const a = check.arms[k]!;
              const c = check.against_control[k];
              const f = check.flagsmith[k];
              return (
                <tr key={k}>
                  <td><span className="arena-who"><span className="duel-dot" style={{ background: ARM_COLOR[k] }} /><b>{armName(record, k)}</b></span></td>
                  <td className="num tnum"><b>{pct(a.rate, 1)}</b> <span className="muted">{num(a.won)} of {num(a.markets)}</span></td>
                  <td className="num tnum">{a.break_even ? pct(a.break_even, 1) : <span className="faint">No data</span>}</td>
                  <td className="num tnum">{c ? <>{points(c.diff)} <span className="muted">({points(c.low)} to {points(c.high)})</span></> : <span className="faint">Baseline</span>}</td>
                  <td className="num tnum">{c ? chance(c.chance_to_win) : <span className="faint">Baseline</span>}</td>
                  <td className="num tnum">{typeof f === 'number' ? chance(f) : <span className="faint">{k === 'control' ? 'Baseline' : 'No data'}</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="small muted tnum">
        {compared.length > 0 && (apart.length
          ? `The two readings fall on different sides of the rule's ${pct(rule.win_above)} for ${apart.map(k => armName(record, k)).join(' and ')}. The verdict is Flagsmith's; read it with that in mind. `
          : `Both readings fall on the same side of the rule's ${pct(rule.win_above)}. `)}
        {num(check.markets)} settled markets in {num(check.windows)} windows, {num(check.draws)} draws of whole windows. The range holds 95% of the draws. Computed {dateTime(check.computed_at)}.
      </div>
    </div>
  );
}

function Result({ record, seal, verdict, approvals, check }: { record: ArenaRecord; seal: Seal; verdict: Verdict; approvals: Approvals; check: ArenaCheck | null }) {
  const { brief } = record;
  const head = headline(record, seal, verdict, null);
  const goal = verdict.table[brief.event.key] ?? {};
  const guard = brief.guardrails[0];
  const placed = guard ? verdict.table[guard.key] ?? {} : {};
  const watch = brief.watch[0];
  const watched = watch ? verdict.watch?.[watch.key] ?? {} : {};
  const arms = ['control', ...AGENTS].filter(k => goal[k]);
  const decided = verdict.state === 'decided';
  return (
    <div className="card arena-result fade-in">
      <div className="card-pad stack">
        <div>
          <h2 className="result-h">{head.title}</h2>
          <div className="card-sub">{head.sub}</div>
        </div>
        {decided && <p className="duel-quote">{named(verdict.why)}</p>}
        {decided && arms.length > 0 && (
          <div className="arena-scroll">
            <table className="table plain">
              <thead>
                <tr>
                  <th>Flagsmith's numbers</th><th className="num">Markets</th><th className="num">{brief.event.name}</th><th className="num">Rate</th><th className="num">Chance to beat the coin</th>
                  {guard && <th className="num">{guard.name} (guardrail)</th>}
                  {watch && <><th className="num">Paper profit</th><th className="num">Per market</th></>}
                </tr>
              </thead>
              <tbody>
                {arms.map(k => {
                  const g = goal[k]!;
                  const p = placed[k];
                  const w = watched[k];
                  return (
                    <tr key={k} className={cx(k === verdict.winner && k !== 'control' && 'won')}>
                      <td><span className="arena-who"><span className="duel-dot" style={{ background: ARM_COLOR[k] }} /><b>{armName(record, k)}</b><span className="muted">{armNote(record, k)}</span></span></td>
                      <td className="num tnum">{num(g.visitors)}</td>
                      <td className="num tnum">{num(g.converted)}</td>
                      <td className="num tnum"><b>{pct(g.rate, 1)}</b></td>
                      <td className="num tnum">{g.chance_to_win === undefined ? <span className="faint">Baseline</span> : chance(g.chance_to_win)}</td>
                      {guard && <td className="num tnum">{p ? `${num(p.converted)} of ${num(p.visitors)}` : <span className="faint">No data</span>}</td>}
                      {watch && <td className={cx('num tnum', tone(w?.sum))}>{w ? money(w.sum) : <span className="faint">No data</span>}</td>}
                      {watch && <td className={cx('num tnum', tone(w?.mean))}>{w ? money(w.mean) : <span className="faint">No data</span>}</td>}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {decided && (
          <div className="facts">
            <div className="fact"><span>Experiment</span><b>{seal.experiment} in {seal.environment.name}</b></div>
            <div className="fact"><span>Read once</span><b>{dateTime(verdict.read_at)}</b></div>
            <div className="fact"><span>Split check</span><b>{typeof verdict.sample_ratio_p === 'number' ? `p = ${verdict.sample_ratio_p.toFixed(2)}` : 'Not run'}</b></div>
            <div className="fact"><span>Agent against agent</span><b>{verdict.head_to_head ? `p = ${verdict.head_to_head.p_value.toFixed(2)}` : 'Not compared'}</b></div>
          </div>
        )}
        {decided && (check
          ? <Second record={record} check={check} rule={verdict.rule} />
          : <div className="small muted">The second reading, by five minute window, has not been computed yet: <span className="mono">npm run arena -- check</span></div>)}
        {decided && (
          <div className="grid cols-2">
            <div className="kv">
              <div className="section-title">What each agent predicted</div>
              {AGENTS.filter(k => verdict.predictions[k]).map(k => {
                const p = verdict.predictions[k]!;
                return (
                  <div className="kv-row" key={k}>
                    <span><b>{armName(record, k)}</b> <span className="muted tnum">{Object.entries(p.predicted).map(([arm, v]) => `${armName(record, arm)} ${pct(v, 1)}`).join(', ')}</span></span>
                    <span className="tnum arena-nowrap">{p.mean_abs_error === null ? 'Not scored' : `Off by ${(p.mean_abs_error * 100).toFixed(1)} points`}</span>
                  </div>
                );
              })}
            </div>
            <div className="kv">
              <div className="section-title">Who approved what</div>
              <Approval label="The start" given={approvals.start} waiting="Not recorded" />
              <Approval label="The rollout" given={approvals.finish} waiting="Waits for a person" />
            </div>
          </div>
        )}
        {decided && !seal.completed_at && !approvals.finish && (
          <CodeBlock title="A person approves the rollout, in their own terminal" lang="sh" code={'npm run arena -- approve finish\nnpm run arena -- finish --approve <code>'} />
        )}
      </div>
    </div>
  );
}

function Approval({ label, given, waiting }: { label: string; given: Approvals['start']; waiting: string }) {
  return (
    <div className="kv-row">
      <span><b>{label}</b></span>
      {given
        ? <span className="arena-approval"><span>{given.by}, {dateTime(given.at)}</span><span className="chip mono">{given.code}</span></span>
        : <span className="muted">{waiting}</span>}
    </div>
  );
}

/* ---------- the playbooks, in plain words ---------- */

function Backtest({ seen, held, hours, who = 'it' }: { seen: Tape; held: Tape; hours: { seen: number; held: number }; who?: string }) {
  return (
    <div className="arena-tape">
      <div className="fact">
        <span>The {hours.seen} hours {who} saw</span>
        <b className="tnum">{pct(seen.rate, 1)}</b>
        <span className="tnum">{num(seen.right)} right of {num(seen.markets)}</span>
      </div>
      <div className="fact honest">
        <span>The {hours.held} hours held back</span>
        <b className="tnum">{pct(held.rate, 1)}</b>
        <span className="tnum">{num(held.right)} right of {num(held.markets)}. The honest number.</span>
      </div>
    </div>
  );
}

function PlaybookCard({ record, k, f }: { record: ArenaRecord; k: AgentKey; f: Finalist }) {
  const hours = { seen: record.brief.past.hours - record.brief.past.held_hours, held: record.brief.past.held_hours };
  return (
    <Card
      title={<><span className="duel-dot" style={{ background: ARM_COLOR[k] }} />{armName(record, k)}<span className="chip">{record.agents[k].stance}</span></>}
      sub={f.playbook.name}
    >
      <div className="stack">
        <p className="arena-claim">{f.hypothesis}</p>
        <ol className="arena-rules">
          {f.playbook.rules.map((r, i) => (
            <li key={i}>
              <span className="arena-rule-n">{i + 1}</span>
              <span>{inWords(r)}{r.why && <small>{r.why}</small>}</span>
              <b>{sideName(r.side)}</b>
            </li>
          ))}
          <li><span className="arena-rule-n" aria-hidden="true" /><span>Otherwise</span><b>{sideName(f.playbook.otherwise)}</b></li>
        </ol>
        <div className="small muted">The first rule that fits makes the call. Right calls on past markets:</div>
        <Backtest seen={f.seen} held={f.held} hours={hours} />
      </div>
    </Card>
  );
}

function Playbooks({ record }: { record: ArenaRecord }) {
  const { brief, coin, past } = record;
  const hours = { seen: brief.past.hours - brief.past.held_hours, held: brief.past.held_hours };
  return (
    <Section
      title="Two playbooks and a coin"
      sub={`Each agent was given a conviction and a fact sheet on ${num(past.seen)} past markets, then wrote rules, attacked its rival's and revised its own. The newest ${num(past.held)} markets were held back from both.`}
    >
      <div className="stack">
        <div className="grid cols-2 duel-agents">
          {AGENTS.map(k => { const f = record.finalists[k]; return f ? <PlaybookCard key={k} record={record} k={k} f={f} /> : null; })}
        </div>
        <Card
          title={<><span className="duel-dot" style={{ background: ARM_COLOR.control }} />Coin<span className="chip">The control</span></>}
          sub={<>One flip per market, no opinion at all. Its seed, <span className="mono">{coin.trader.seed}</span>, was published before the start, so every flip can be checked.</>}
        >
          <div className="stack">
            <Backtest seen={coin.seen} held={coin.held} hours={hours} who="the agents" />
            {record.agreement !== null && (
              <div className="small muted">The two playbooks make the same call on {pct(record.agreement, 1)} of the held back markets, so they will often win and lose together.</div>
            )}
          </div>
        </Card>
      </div>
    </Section>
  );
}

function Terms({ record, seal }: { record: ArenaRecord; seal: Seal | null }) {
  const { brief } = record;
  const split = seal?.split ?? { control: 100 - AGENTS.reduce((n, k) => n + (brief.split[k] ?? 0), 0), ...brief.split };
  const watch = brief.watch[0];
  return (
    <Section title="The rule, fixed in advance" sub="Written down before the first trade. Nobody, human or agent, can move it once the experiment has started.">
      <div className="stack">
        <div className="facts arena-facts">
          <div className="fact"><span>Sample</span><b>{num(brief.rule.min_per_arm)} markets per version</b></div>
          <div className="fact"><span>A playbook wins with</span><b>Over {pct(brief.rule.win_above)} chance to beat the coin</b></div>
          <div className="fact"><span>Goal</span><b>{brief.event.name}</b></div>
          <div className="fact"><span>Guardrail</span><b>{brief.guardrails.map(g => g.name).join(', ') || 'None'}</b></div>
          <div className="fact"><span>One unit</span><b>One market</b></div>
          <div className="fact"><span>Split</span><b className="tnum">{['control', ...AGENTS].map(k => `${armName(record, k)} ${split[k] ?? 0}`).join(' / ')}</b></div>
          <div className="fact"><span>Shown, not judged</span><b>{watch ? 'Paper profit per market' : 'Nothing'}</b></div>
          <div className="fact"><span>The result is read</span><b>Once</b></div>
        </div>
        <details className="more">
          <summary>How one market works</summary>
          <div className="more-body">
            <span>{brief.venue.about}</span>
            <span>
              Every market gets {dollars(brief.venue.stake)} of paper money, filled from the real order book with the market's fee. A market is skipped, before any version is asked,
              when either side costs more than {brief.venue.max_price.toFixed(2)} a share. Flagsmith's flag <span className="mono">{brief.flag}</span> in the environment {brief.environment} decides which version trades it.
            </span>
          </div>
        </details>
      </div>
    </Section>
  );
}

/* ---------- the page ---------- */

/** Whether the runner is still talking. It publishes at least once a minute, so three quiet minutes mean it is down. */
function Pulse({ beat }: { beat: ReturnType<typeof heartbeat> }) {
  if (!beat) return <span className="chip v-warn"><Icon name="alert" size={12} />The runner has not been heard from</span>;
  if (beat.live) return <span className="chip v-pass"><span className="dot arena-beat" />Runner live</span>;
  return (
    <span className="chip v-warn">
      <Icon name="alert" size={12} />
      Runner last heard {beat.minutes < 60 ? `at ${clock(beat.at)}, ${beat.minutes} minutes ago` : `on ${dateTime(beat.at)}`}
    </span>
  );
}

/** Asks again every ten seconds while the tab is in view, and at once when it comes back. */
function useArena() {
  const arena = useAsync(() => api.arena(), []);
  useEffect(() => {
    const again = () => { if (document.visibilityState === 'visible') arena.reload(); };
    const t = setInterval(again, POLL);
    document.addEventListener('visibilitychange', again);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', again); };
  }, [arena.reload]);
  return arena;
}

function venueLine(record: ArenaRecord) {
  const { venue } = record.brief;
  return `Polymarket's five minute Up or Down markets on ${venue.assets.map(a => a.toUpperCase()).join(', ')}. Each market gets ${dollars(venue.stake)} of paper money, filled from the real order book. No order is ever placed.`;
}

export function ArenaPage() {
  const arena = useArena();
  if (arena.error && !arena.data) return <ErrorState error={arena.error} onRetry={arena.reload} />;
  if (arena.loading && arena.data === undefined) return <div className="stack"><Skeleton h={120} /><Skeleton h={320} /></div>;
  const { record, seal, verdict, state, approvals, check, heard, planned } = parts(arena.data);
  if (!record) {
    return (
      <div className="fade-in">
        <PageHead title="Arena" sub="Two AI agents each write a trading playbook. A coin is the control. A Flagsmith experiment decides." />
        <Card>
          <Empty icon="activity" title="No arena yet">
            The debate writes the two playbooks and the record this page reads: <span className="mono">npm run arena -- debate</span>
          </Empty>
        </Card>
      </div>
    );
  }
  const { brief } = record;
  const head = headline(record, seal, verdict, state);
  const need = brief.rule.min_per_arm;
  const settled = state ? state.order.reduce((n, k) => n + (state.arms[k]?.settled ?? 0), 0) : 0;
  const risk = state?.risk;
  const stopped = !verdict && !!risk?.halted_at;
  // The runner is only expected to speak while the experiment is running and undecided.
  const beat = seal && !verdict ? heartbeat(heard, state?.updated_at) : null;
  return (
    <div className="fade-in">
      <PageHead
        title={record.name}
        sub={<>{brief.goal} Two AI agents each wrote a playbook, a coin is the control, and Flagsmith deals every live market to one of the three.</>}
        actions={(
          <>
            <span className={cx('chip', verdict ? 'v-pass' : stopped ? 'v-block' : 'v-accent')}>
              <span className="dot" />{verdict ? 'Decided' : stopped ? 'Stopped by the loss limit' : seal ? 'Running' : 'Waiting for a person'}
            </span>
            {seal && !verdict && <Pulse beat={beat} />}
          </>
        )}
      />

      {verdict && seal ? <Result record={record} seal={seal} verdict={verdict} approvals={approvals} check={check} /> : (
        <div className={cx('card fade-in', stopped && 'arena-stopped')} role={stopped ? 'alert' : undefined}>
          <div className="card-pad stack">
            <div>
              <h2 className="result-h">{head.title}</h2>
              <div className="card-sub">{head.sub}</div>
            </div>
            {stopped && risk && (
              <>
                <p className="arena-stopped-why tnum">
                  The last {num(risk.over)} settled markets lost <b>{dollars(risk.lost)}</b> of paper money between them, and the limit is <b>{dollars(risk.max_loss)}</b>.
                </p>
                <CodeBlock title="A person restarts it, in their own terminal" lang="sh" code="npm run arena -- resume" />
              </>
            )}
            {!stopped && <div className="duel-note"><Icon name="info" size={20} /><span><b>Paper money.</b> {venueLine(record)}</span></div>}
            {!seal && <CodeBlock title="A person approves the start, in their own terminal" lang="sh" code={'npm run arena -- approve start\nnpm run arena -- start --approve <code>\nnpm run arena -- run'} />}
          </div>
        </div>
      )}

      {seal && (
        <Section
          title={verdict ? 'Every market, replayed' : 'Live'}
          sub={`One dot is one settled market. It lands at the front of its lane when the call was right.${verdict ? ' These are the runner\'s own counts; the table above is Flagsmith\'s.' : ''}`}
        >
          <div className="stack">
            {state?.note && !stopped && <div className="duel-note"><Icon name="hourglass" size={20} /><span>{state.note}</span></div>}
            <div className="card duel-replay arena-lanes">
              <div className="card-pad">
                {state && settled > 0
                  ? <Lanes record={record} state={state} verdict={verdict} />
                  : <Empty icon="hourglass" title="No market has settled yet">A market settles about five and a half minutes after its trade, when Polymarket resolves it.</Empty>}
              </div>
            </div>
            {state && (
              <div className="arena-arms">
                {shown(state.order).map(k => <ArmTile key={k} record={record} k={k} t={state.arms[k]!} need={need} />)}
              </div>
            )}
            {state && (
              <div className="small muted tnum arena-fine">
                <span>
                  {num(state.open)} open, {num(state.skipped)} skipped before any version was asked{state.voided > 0 && `, ${num(state.voided)} void`}
                  {state.after.markets > 0 && `, ${num(state.after.markets)} traded after the experiment had its sample (not counted)`}. Updated {dateTime(state.updated_at)}.
                </span>
                {settled > 0 && (
                  <span>
                    Beating the coin is not making money. A version also has to clear its break even, the share of right calls that pays for the spread and the fee.
                    A win here earns the next stage, not real money.
                  </span>
                )}
              </div>
            )}
          </div>
        </Section>
      )}

      <Controls record={record} state={state} planned={planned} />

      {seal && state && (
        <Section title="Paper profit" sub="The running total per version, one step per five minute window. Flagsmith shows it next to the goal; the rule does not read it.">
          <Card><Curve record={record} state={state} /></Card>
        </Section>
      )}

      {seal && state && (
        <Section title="Latest trades" sub="The call, the price paid per share on paper, and how Polymarket resolved the market.">
          <Card pad={false}><Feed record={record} rows={state.feed} /></Card>
        </Section>
      )}

      <Playbooks record={record} />
      <Terms record={record} seal={seal} />
    </div>
  );
}

/** The overview's headline: the lanes and the score when there are any, the two playbooks before that. */
export function ArenaHeadline() {
  const arena = useArena();
  const { record, seal, verdict, state } = parts(arena.data);
  if (arena.loading && arena.data === undefined) return <Skeleton h={240} />;
  if (!record) return null;
  const head = headline(record, seal, verdict, state);
  const way = <a className="btn" href="#/arena">See the arena<Icon name="chevronRight" size={14} /></a>;
  const settled = state ? state.order.reduce((n, k) => n + (state.arms[k]?.settled ?? 0), 0) : 0;
  return (
    <div className="card duel-replay arena-lanes fade-in">
      <div className="card-head">
        <div>
          <div className="card-title">{record.name}</div>
          <div className="card-sub"><b>{head.title}.</b> {head.sub}</div>
        </div>
        {way}
      </div>
      <div className="card-pad stack">
        {state && settled > 0 ? (
          <>
            <Lanes record={record} state={state} verdict={verdict} />
            <div className="small muted tnum">
              Paper profit, no order is ever placed: {shown(state.order).map(k => `${armName(record, k)} ${money(state.arms[k]?.profit ?? 0)}`).join(', ')}.
            </div>
          </>
        ) : (
          <div className="facts arena-before">
            {AGENTS.map(k => {
              const f = record.finalists[k];
              return f ? <div className="fact" key={k}><span>{armName(record, k)}, {record.agents[k].stance.toLowerCase()}</span><b>{f.playbook.name}</b><span className="tnum">{pct(f.held.rate, 1)} right on the markets held back</span></div> : null;
            })}
            <div className="fact"><span>Coin, the control</span><b>One flip per market</b><span className="tnum">{pct(record.coin.held.rate, 1)} right on the markets held back</span></div>
            <div className="fact"><span>The rule</span><b>{num(record.brief.rule.min_per_arm)} markets per version</b><span>Over {pct(record.brief.rule.win_above)} chance to beat the coin</span></div>
          </div>
        )}
      </div>
    </div>
  );
}
