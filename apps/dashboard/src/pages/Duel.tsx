import { useEffect, useRef, useState } from 'react';
import type { AgentKey } from '../../../../packages/duel/src/agents.ts';
import type { DuelRecord } from '../../../../packages/duel/src/debate.ts';
import { Icon } from '../components/Icons.tsx';
import { Card, CodeBlock, Empty, ErrorState, PageHead, Section, Seg, Skeleton, cx } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import { mountDuelViz } from '../lib/duel-viz.ts';
import { num, pct, plural } from '../lib/format.ts';
import { useAsync } from '../lib/hooks.ts';
import { FirstScreen } from './FirstScreen.tsx';

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
interface Row { visitors: number; converted: number; rate: number; chance_to_win?: number; ci?: [number, number]; fewer_p?: number }
interface Verdict {
  state: 'decided' | 'void';
  winner: string | null;
  why: string;
  /** The code a person's rollout approval is bound to. */
  approve?: string;
  read_at: string;
  sample_ratio_p?: number | null;
  sample_ratio_by?: string;
  rule: { min_per_arm: number; win_above: number; harm_below: number };
  table: Record<string, Record<string, Row | null>>;
  head_to_head?: { between: string[]; p_value: number };
  excluded_visitors?: number;
  /** Who judged each guardrail: Flagsmith, or the skill's own exact test when Flagsmith gave no estimate. */
  guardrails_by?: Record<string, string>;
  predictions: Record<string, { by: string; predicted: Record<string, number>; mean_abs_error: number | null }>;
}
/** The simulated visitors' own summary (scripts/traffic/personas.mjs). */
interface Traffic {
  kind: string;
  visitors: number;
  model: 'stub' | { requested: string; ids: string[] };
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}
/** The same run one visitor at a time (scripts/traffic/replay.mjs). */
interface Replay { arms: string[]; visits: string }
type Arm = 'control' | AgentKey;

const AGENTS: AgentKey[] = ['agent_a', 'agent_b'];
const ARMS: Arm[] = ['control', ...AGENTS];
const ARM_LABEL: Record<Arm, string> = { control: "Today's screen", agent_a: 'Agent A', agent_b: 'Agent B' };
const ARM_COLOR: Record<Arm, string> = { control: 'var(--text-3)', agent_a: 'var(--accent)', agent_b: 'var(--brand-1)' };
const armLabel = (k: string) => ARM_LABEL[k as Arm] ?? k;
/** A duel's record is written up in UTC, so the page shows the same clock to everyone. */
const dateTime = (iso: string) =>
  `${new Date(iso).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} UTC`;
/** The skill writes its reasons with the versions' keys; the page uses their names. */
const named = (text: string) => text.replace(/\bagent_a\b/g, 'Agent A').replace(/\bagent_b\b/g, 'Agent B')
  .replace(/\bControl\b/g, "Today's screen").replace(/\b(the )?control( version)?\b/g, "today's screen")
  // The skill rounds 0.99999998 to "100.0%"; no chance is ever that.
  .replace(/\b100\.0% chance/g, 'above 99.9% chance').replace(/\bchi-square\b/g, 'chi square');
const pValue = (p: number, digits = 2) => (p < 10 ** -digits ? `p < ${(10 ** -digits).toFixed(digits)}` : `p = ${p.toFixed(digits)}`);
/** A chance of 0.99999998 is not "100%". */
const chance = (v: number) => (v > 0.999 ? 'Above 99.9%' : v < 0.001 ? 'Below 0.1%' : pct(v, 1));

type Who = 'person' | 'agents' | 'referee' | 'flagsmith';
const WHO: Record<Who, string> = { person: 'A person', agents: 'The agents', referee: 'The referee', flagsmith: 'Flagsmith' };

/** The duel's eight steps, and how far the files on disk say it has come. */
function stages(record: DuelRecord, seal: Seal | null, verdict: Verdict | null) {
  const entered = AGENTS.filter(k => record.finalists[k]).length;
  const rejected = AGENTS.reduce((n, k) => n + (record.proposals[k]?.referee.length ?? 0) + (record.revisions[k]?.referee.length ?? 0), 0);
  const started = !!seal?.started_at;
  const over = !!seal?.completed_at;
  const list: Array<{ title: string; who: Who; done: boolean; note: string; waiting: string }> = [
    { title: 'The brief', who: 'person', done: true, note: 'One goal and the one event that counts.', waiting: '' },
    { title: 'Two proposals', who: 'agents', done: true, note: 'Opposite briefs. Each writes a first screen and a hypothesis.', waiting: '' },
    { title: 'Cross examination', who: 'agents', done: true, note: 'Each attacks the other, then may revise once.', waiting: '' },
    { title: 'Referee check', who: 'referee', done: true, note: `${entered} of 2 screens entered. ${rejected ? `${rejected} problems sent back.` : 'Nothing sent back.'}`, waiting: '' },
    { title: 'Start approved', who: 'person', done: started, note: started ? `Experiment ${seal.experiment} in ${seal.environment.name}.` : 'Nothing exists in Flagsmith until a person says yes.', waiting: 'Waiting for a person to approve the start' },
    { title: 'The experiment', who: 'flagsmith', done: !!verdict || over, note: 'Three versions, one flag. Any change to the run breaks the seal.', waiting: 'The experiment is running' },
    { title: 'The verdict', who: 'referee', done: !!verdict, note: `Read once, when every version has ${record.brief.rule.min_per_arm} visitors.`, waiting: 'Waiting for the verdict' },
    { title: 'Rollout approved', who: 'person', done: over, note: over ? `Now serving: ${seal.decision === 'stopped' ? "today's screen (stopped)" : armLabel(seal.decision ?? '')}.` : 'The winner ships only after a second yes.', waiting: 'Waiting for a person to approve the rollout' },
  ];
  const now = list.findIndex(s => !s.done);
  return list.map((s, i) => ({ ...s, state: s.done ? 'done' : i === now ? 'now' : 'later' }));
}

/** What is still to do once the verdict is in. */
const afterVerdict = (seal: Seal, agentWon: boolean) => (agentWon
  ? (seal.completed_at ? 'It now ships to everyone.' : 'The rollout waits for a person.')
  : (seal.completed_at ? 'The experiment is closed.' : 'Closing the experiment waits for a person.'));

/** The duel in one line, for this page's result card and the overview. */
function duelHeadline(record: DuelRecord, seal: Seal | null, verdict: Verdict | null): { title: string; sub: string } {
  if (!seal?.started_at) return { title: 'Two agents have each written a new first screen', sub: 'Nothing exists in Flagsmith yet. The experiment starts when a person approves it.' };
  if (!verdict) return { title: 'The duel is running', sub: `Experiment ${seal.experiment} in Flagsmith. The verdict is read once, when every version has ${record.brief.rule.min_per_arm} visitors.` };
  if (verdict.state === 'void') return { title: 'No verdict: the run is void', sub: named(verdict.why) };
  const goal = verdict.table[record.brief.event.key] ?? {};
  const did = record.brief.event.name.toLowerCase();
  if (verdict.winner === 'control' || !verdict.winner || !goal[verdict.winner] || !goal.control) {
    return { title: "Today's screen stays", sub: `Neither agent's screen cleared the rule that was fixed before the start. ${afterVerdict(seal, false)}` };
  }
  return {
    title: `${armLabel(verdict.winner)} won the duel`,
    sub: `${pct(goal[verdict.winner]!.rate, 1)} of its visitors ${did}, against ${pct(goal.control.rate, 1)} on today's screen. ${afterVerdict(seal, true)}`,
  };
}

function Bars({ values, highlight }: { values: Partial<Record<Arm, number>>; highlight?: Arm }) {
  const max = Math.max(0.01, ...ARMS.map(k => values[k] ?? 0));
  return (
    <div>
      {ARMS.filter(k => values[k] !== undefined).map(k => (
        <div key={k} className="hbar" style={{ gridTemplateColumns: '112px minmax(0, 1fr) 48px' }}>
          <span className={cx('small', k !== highlight && 'muted')}>{ARM_LABEL[k]}</span>
          <div className="hbar-track"><div className="hbar-fill" style={{ width: `${((values[k] ?? 0) / max) * 100}%`, background: ARM_COLOR[k] }} /></div>
          <span className="small tnum" style={{ textAlign: 'right' }}>{pct(values[k] ?? 0)}</span>
        </div>
      ))}
    </div>
  );
}

function AgentCard({ record, k }: { record: DuelRecord; k: AgentKey }) {
  const agent = record.agents[k];
  const entry = record.finalists[k];
  const rival: AgentKey = k === 'agent_a' ? 'agent_b' : 'agent_a';
  const against = record.attacks[rival];
  const revision = record.revisions[k];
  return (
    <Card
      title={<><span className="duel-dot" style={{ background: ARM_COLOR[k] }} />{agent.name}</>}
      sub={agent.conviction}
      actions={<span className="chip">Told to {agent.stance.toLowerCase()}</span>}
    >
      <div className="stack" style={{ gap: 24 }}>
        {!entry && <Empty icon="octagon" title="Forfeited">The referee rejected this screen twice, so it does not enter the experiment.</Empty>}
        {entry && (
          <>
            <div>
              <div className="section-title">Its hypothesis</div>
              <div className="duel-quote">{entry.hypothesis}</div>
            </div>
            {entry.predicts && (
              <div>
                <div className="section-title">Its forecast: the share of visitors who run a check</div>
                <Bars values={entry.predicts} highlight={k} />
              </div>
            )}
          </>
        )}
        {(against || revision) && (
          <details className="more">
            <summary>The debate</summary>
            <div className="more-body">
              {against && (
                <div>
                  <div className="section-title">{record.agents[rival].name} attacked it</div>
                  <ul className="duel-list">{against.attacks.map((a, i) => <li key={i}>{a}</li>)}</ul>
                </div>
              )}
              {against?.concedes && (
                <div>
                  <div className="section-title">And conceded</div>
                  <div>{against.concedes}</div>
                </div>
              )}
              {revision && (
                <div>
                  <div className="section-title">{entry?.from === 'revision' ? 'What it changed in reply' : 'Its revision was rejected, so the first proposal entered'}</div>
                  <div>{revision.changed}</div>
                </div>
              )}
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

function SimulatedNote({ traffic }: { traffic: Traffic }) {
  return (
    <div className="duel-note">
      <Icon name="bot" size={18} />
      <div>
        <b>The visitors in this run are simulated.</b> They are {traffic.kind.replace(/, not people$/, '')}, not people: {num(traffic.visitors)} visits,
        each one a language model ({traffic.model === 'stub' ? 'a fixed rule' : traffic.model.ids.join(', ') || traffic.model.requested}) playing one invented person who is shown the real page and decides what to do.
        No persona is told what is measured or which version it sees. The numbers say how a model reads each screen. They are not a forecast of what people would do.
      </div>
    </div>
  );
}

function ResultCard({ record, seal, verdict, traffic }: { record: DuelRecord; seal: Seal | null; verdict: Verdict; traffic: Traffic | null }) {
  const goal = verdict.table[record.brief.event.key] ?? {};
  const did = record.brief.event.name.toLowerCase();
  const guardrails = record.brief.guardrails.filter(g => verdict.table[g.key]);
  const scored = Object.entries(verdict.predictions).filter(([, p]) => p.mean_abs_error !== null).sort(([, a], [, b]) => a.mean_abs_error! - b.mean_abs_error!);
  // A version is out when a guardrail's judgement, Flagsmith's or the referee's exact test, falls below the rule's floor.
  const out = (k: string) => k !== 'control' && guardrails.some(g => {
    const r = verdict.table[g.key]?.[k];
    return r != null && (r.chance_to_win ?? r.fewer_p ?? 1) < verdict.rule.harm_below;
  });
  const head = duelHeadline(record, seal, verdict);
  const waiting = verdict.state === 'decided' && !seal?.completed_at;
  return (
    <div className="card">
      <div className="card-pad stack" style={{ gap: 24 }}>
        <div>
          <div className="section-title">The verdict, read once on {dateTime(verdict.read_at)}</div>
          <h2 className="result-h">{head.title}</h2>
          <div className="card-sub">{head.sub}</div>
        </div>

        <div className="score">
          {ARMS.filter(k => goal[k]).map(k => {
            const r = goal[k]!;
            return (
              <div key={k} className={cx('score-row', verdict.winner === k && 'win')}>
                <div className="score-name">
                  <span className="duel-dot" style={{ background: ARM_COLOR[k] }} />{ARM_LABEL[k]}
                  {verdict.winner === k && <span className="chip v-pass">Winner</span>}
                  {out(k) && <span className="chip v-block">Out on a guardrail</span>}
                  <small>{k === 'control' ? 'The overview as it was' : `Told to ${record.agents[k].stance.toLowerCase()}`}</small>
                </div>
                <div className="score-track" role="img" aria-label={`${ARM_LABEL[k]}: ${pct(r.rate, 1)} ${did}`}>
                  <div className="score-fill" style={{ width: `${r.rate * 100}%`, background: ARM_COLOR[k] }} />
                </div>
                <div className="score-num">
                  <b>{pct(r.rate, 1)}</b>
                  <span>{num(r.converted)} of {num(r.visitors)} visitors {did}</span>
                  <span>{k === 'control' ? 'The baseline' : r.chance_to_win === undefined ? 'Not judged' : `${chance(r.chance_to_win)} chance to beat today's screen`}</span>
                </div>
              </div>
            );
          })}
        </div>

        {traffic && <SimulatedNote traffic={traffic} />}

        {waiting && (
          <CodeBlock
            title="The rollout is a person's decision, made in their own terminal"
            code={`npm run duel -- approve finish\nnpm run duel -- finish --approve ${verdict.approve ?? '<code>'}`}
          />
        )}

        <div className="stack" style={{ gap: 8 }}>
          <details className="more">
            <summary>How the verdict was reached</summary>
            <div className="more-body">
              <div>
                <b>The rule, fixed before the start.</b> Every version needs {num(verdict.rule.min_per_arm)} visitors. A version wins above {pct(verdict.rule.win_above)} chance
                to beat today's screen, unless a guardrail falls below {pct(verdict.rule.harm_below)}. If both agents qualify, the higher rate wins.
              </div>
              <div><b>The referee's reading.</b> {named(verdict.why)}</div>
              {verdict.head_to_head && (
                <div>
                  <b>Agent against agent.</b> {pValue(verdict.head_to_head.p_value, 3)} on a two proportion z test of Flagsmith's counts.
                  Flagsmith itself compares each version with today's screen only.
                </div>
              )}
              {guardrails.map(g => {
                const rows = AGENTS.filter(k => verdict.table[g.key]?.[k]).map(k => [k, verdict.table[g.key]![k]!] as const);
                if (!rows.length || !verdict.guardrails_by?.[g.key]) return null;
                const ours = rows.filter(([, r]) => r.fewer_p !== undefined).length;
                return (
                  <div key={g.key}>
                    <b>Guardrail: {g.name.toLowerCase()}.</b>{' '}
                    {ARMS.filter(k => verdict.table[g.key]?.[k]).map(k => `${ARM_LABEL[k]} ${num(verdict.table[g.key]![k]!.converted)} of ${num(verdict.table[g.key]![k]!.visitors)}`).join(', ')}.
                    {' '}Judged: {rows.map(([k, r]) => `${ARM_LABEL[k]} ${r.fewer_p !== undefined ? pValue(r.fewer_p) : r.chance_to_win !== undefined ? pct(r.chance_to_win, 1) : 'not judged'}`).join(', ')}.
                    {' '}{ours === 0
                      ? "These are Flagsmith's chances to beat today's screen."
                      : ours === rows.length
                        ? "Flagsmith gives no estimate at this few conversions, so the referee ran a one sided Fisher exact test on Flagsmith's counts."
                        : "A percentage is Flagsmith's chance to beat today's screen. Where Flagsmith gave no estimate, the referee ran a one sided Fisher exact test on Flagsmith's counts and shows its p."}
                    {' '}Below {pct(verdict.rule.harm_below)} a version is out.
                  </div>
                );
              })}
              {typeof verdict.sample_ratio_p === 'number' && (
                <div>
                  <b>Split check.</b> {pValue(verdict.sample_ratio_p)}{verdict.sample_ratio_by ? `, by ${verdict.sample_ratio_by}` : ''}.
                  Below 0.001 the visitors did not split as planned and the run would be void.
                </div>
              )}
            </div>
          </details>
          {scored.length > 0 && (
            <details className="more">
              <summary>Which agent forecast it better</summary>
              <div className="more-body">
                <div>Before the start each agent wrote down the rate it expected for every version. Both expected far less than what happened.</div>
                <div className="grid cols-2">
                  {scored.map(([k, p], i) => (
                    <div key={k} className="kv" style={{ background: 'var(--surface)' }}>
                      <div className="kv-row"><b>{p.by}</b>{i === 0 && scored.length > 1 && <span className="chip v-pass">Closer</span>}</div>
                      {ARMS.filter(a => typeof p.predicted[a] === 'number' && goal[a]).map(a => (
                        <div key={a} className="kv-row"><span className="muted">{ARM_LABEL[a]}</span><span className="tnum">said {pct(p.predicted[a]!)}, was {pct(goal[a]!.rate, 1)}</span></div>
                      ))}
                      <div className="kv-row"><span className="muted">Off by, on average</span><span className="tnum">{(p.mean_abs_error! * 100).toFixed(1)} points</span></div>
                    </div>
                  ))}
                </div>
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/** The replay plays once per visit to the dashboard. Coming back to the overview finds it finished. */
let replayed = false;

/** The duel on the overview: its experiment replayed one visitor at a time, with a way in. */
export function DuelReplay() {
  const duel = useAsync(() => api.duel(), []);
  const stage = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLSpanElement>(null);
  const record = duel.data?.record as DuelRecord | null | undefined;
  const seal = (duel.data?.seal ?? null) as Seal | null;
  const verdict = (duel.data?.verdict ?? null) as Verdict | null;
  const goal = record && seal?.started_at && verdict?.state === 'decided' ? verdict.table[record.brief.event.key] : undefined;
  const simulated = !!duel.data?.traffic;
  const agentWon = !!verdict?.winner && verdict.winner !== 'control';

  useEffect(() => {
    if (!stage.current || !record || !verdict || !goal) return;
    const replay = (duel.data?.replay ?? null) as Replay | null;
    // The replay numbers the versions in its own order. Without one, the page's order will do.
    const logged = replay?.arms.every(k => goal[k]) ? replay : null;
    const viz = mountDuelViz(stage.current, {
      lanes: (logged?.arms ?? ARMS.filter(k => goal[k])).map(k => ({
        key: k,
        label: armLabel(k),
        note: k === 'control' ? 'The overview as it was' : `Told to ${record.agents[k as AgentKey]?.stance.toLowerCase() ?? 'win'}`,
        visitors: goal[k]!.visitors,
        converted: goal[k]!.converted,
      })),
      visits: logged?.visits,
      baseline: 'control',
      did: record.brief.event.name.toLowerCase(),
      winner: verdict.winner,
      result: agentWon ? `${armLabel(verdict.winner!)} wins` : "Today's screen stays",
      status: status.current,
      caption: `One dot is one ${simulated ? 'simulated ' : ''}visitor.`,
      autoplay: !replayed,
      delay: 400,
      onPlay: () => { replayed = true; },
    });
    return () => viz.destroy();
  }, [duel.data]);

  if (!record) return null;
  const way = <a className="btn" href="#/duel">See the duel<Icon name="chevronRight" size={14} /></a>;
  if (!goal || !seal) {
    const head = duelHeadline(record, seal, verdict);
    return (
      <div className="card duel-replay fade-in">
        <div className="card-head">
          <div><div className="card-title">{head.title}</div><div className="card-sub">{head.sub}</div></div>
          {way}
        </div>
      </div>
    );
  }
  return (
    <div className="card duel-replay fade-in">
      <div className="card-head">
        <div>
          <div className="card-title">{record.name}<span ref={status} className="chip mono" /></div>
          <div className="card-sub">
            Two AI agents each wrote a new first screen. Experiment {seal.experiment} in Flagsmith ran both against today's{simulated && ' on simulated visitors'}. {afterVerdict(seal, agentWon)}
          </div>
        </div>
        {way}
      </div>
      <div className="card-pad"><div ref={stage} /></div>
    </div>
  );
}

export function DuelPage() {
  const duel = useAsync(() => api.duel(), []);
  const [shown, setShown] = useState<AgentKey>('agent_a');
  // The page follows the files: a start, an audit or a verdict in the terminal shows up here.
  useEffect(() => {
    const t = setInterval(duel.reload, 20_000);
    return () => clearInterval(t);
  }, [duel.reload]);

  if (duel.error) return <ErrorState error={duel.error} onRetry={duel.reload} />;
  if (duel.loading && duel.data === undefined) return <div className="stack"><Skeleton h={120} /><Skeleton h={320} /></div>;
  const record = duel.data?.record as DuelRecord | null | undefined;
  if (!record) {
    return (
      <div className="fade-in">
        <PageHead title="The duel" sub="Two agents propose competing changes. A Flagsmith experiment settles it." />
        <Card><Empty icon="bot" title="No duel has been run yet">Run <code>npm run duel -- debate</code> in the repository. The agents' proposals and the whole transcript appear here.</Empty></Card>
      </div>
    );
  }
  const seal = duel.data?.seal as Seal | null;
  const verdict = duel.data?.verdict as Verdict | null;
  const traffic = duel.data?.traffic as Traffic | null;
  const steps = stages(record, seal, verdict);
  const now = steps.find(s => s.state === 'now');
  const entered = AGENTS.filter(k => record.finalists[k]);
  const preview = record.finalists[shown] ?? record.finalists[entered[0] ?? 'agent_a'];
  const audits = record.steps.filter(s => s.step === 'audit');
  const lastAudit = audits.at(-1)?.line as { sealed?: boolean; drift?: string[] } | undefined;
  const split = seal?.split ?? { control: 100 - record.brief.split.agent_a - record.brief.split.agent_b, ...record.brief.split };
  const head = duelHeadline(record, seal, verdict);

  return (
    <div className="fade-in">
      <PageHead
        title={record.name}
        sub={record.brief.goal}
        actions={<span className={cx('chip', now ? 'v-accent' : 'v-pass')}><span className="dot" />{now ? now.waiting : 'Finished'}</span>}
      />

      {verdict ? <ResultCard record={record} seal={seal} verdict={verdict} traffic={traffic} /> : (
        <div className="card">
          <div className="card-pad stack" style={{ gap: 24 }}>
            <div>
              <div className="section-title">No verdict yet</div>
              <h2 className="result-h">{head.title}</h2>
              <div className="card-sub">{head.sub} Until then only visitor counts are read, never conversions.</div>
            </div>
            {!seal?.started_at && <CodeBlock title="A person approves the start, in their own terminal" code={'npm run duel -- approve start\nnpm run duel -- start --approve <code>'} />}
            {traffic && <SimulatedNote traffic={traffic} />}
          </div>
        </div>
      )}

      <Section title="How a duel runs" sub="The agents argue and write. They hold no Flagsmith credentials. A person decides the start and the rollout, and a referee checks everything in between.">
        <ol className="duel-stages">
          {steps.map((s, i) => (
            <li key={s.title} className={s.state}>
              <span className="duel-num">{s.state === 'done' ? <Icon name="check" size={14} strokeWidth={2.4} /> : i + 1}</span>
              <b>{s.title}</b>
              <span>{s.note}</span>
              <span className="duel-who">{WHO[s.who]}</span>
            </li>
          ))}
        </ol>
      </Section>

      <Section title="The two agents" sub={`Both got the same brief and the same facts, and opposite convictions. Model: ${record.model}. The whole debate took ${record.usage.calls} model calls, ${record.usage.seconds} seconds and ${num(record.usage.tokens.in + record.usage.tokens.out)} tokens.`}>
        <div className="grid cols-2 duel-agents">
          {AGENTS.map(k => <AgentCard key={k} record={record} k={k} />)}
        </div>
      </Section>

      {preview && (
        <Section
          title="The screens they entered"
          sub="Each agent's screen is stored whole as the value of its version of the flag, so what you see here is what Flagsmith serves. The button works; from this page it counts nothing."
          actions={entered.length > 1 && <Seg value={shown} onChange={setShown} options={entered.map(k => ({ value: k, label: ARM_LABEL[k] }))} />}
        >
          <FirstScreen key={shown} screen={preview.screen} preview />
          <div className="small faint" style={{ textAlign: 'center', maxWidth: 680, margin: '0 auto' }}>Today's screen, the control version: {record.brief.today}</div>
        </Section>
      )}

      <Section title="The experiment" sub="Flagsmith's API accepts edits to a running experiment, so the duel seals the run at the start and audits it against the seal. A verdict is refused while the seal is broken.">
        <Card>
          <div className="stack" style={{ gap: 24 }}>
            <div className="facts">
              <div className="fact"><span>Flagsmith experiment</span><b>{seal?.started_at ? seal.experiment : 'Not started'}</b></div>
              <div className="fact"><span>Environment</span><b>{seal?.environment.name ?? record.brief.environment}</b></div>
              <div className="fact"><span>Flag</span><b className="mono">{record.brief.flag}</b></div>
              <div className="fact"><span>The event that counts</span><b className="mono">{record.brief.event.key}</b></div>
              <div className="fact"><span>Started</span><b>{seal?.started_at ? dateTime(seal.started_at) : 'Waiting for approval'}</b></div>
              <div className="fact"><span>Finished</span><b>{seal?.completed_at ? dateTime(seal.completed_at) : 'Not yet'}</b></div>
              <div className="fact"><span>Visitors needed per version</span><b>{num(record.brief.rule.min_per_arm)}</b></div>
              <div className="fact"><span>Audits against the seal</span><b>{audits.length === 0 ? 'None yet' : `${plural(audits.length, 'audit')}, ${lastAudit?.sealed ? 'seal intact' : 'seal broken'}`}</b></div>
            </div>
            <div className="stack" style={{ gap: 12 }}>
              <div className="section-title" style={{ margin: 0 }}>How visitors are split</div>
              <div className="arms">{ARMS.filter(k => split[k]).map(k => <span key={k} style={{ width: `${split[k]}%`, background: ARM_COLOR[k] }} />)}</div>
              <div className="legend">{ARMS.filter(k => split[k]).map(k => <span key={k}><i style={{ background: ARM_COLOR[k] }} />{ARM_LABEL[k]} {split[k]}%</span>)}</div>
            </div>
            {audits.length > 0 && !lastAudit?.sealed && (
              <div>
                <div className="section-title">What the last audit found changed, on {dateTime(audits.at(-1)!.at)}</div>
                <ul className="duel-list">{(lastAudit?.drift ?? []).map((d, i) => <li key={i}>{named(d)}</li>)}</ul>
              </div>
            )}
          </div>
        </Card>
      </Section>
    </div>
  );
}
