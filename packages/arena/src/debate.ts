/*
 * One arena, up to the point where a person has to decide: two playbooks, a cross-examination,
 * one revision each, the referee's check on every playbook, and its score on the day of markets
 * no agent saw. Nothing here touches Flagsmith or a market.
 */
import type { Ask } from '@oakenshield/duel';
import { AGENTS, AGENT_KEYS, attack, propose, revise, rivalOf } from './agents.ts';
import type { AgentKey, Attack, Brief, Proposal, Revision } from './agents.ts';
import { factSheet } from './history.ts';
import type { Past } from './history.ts';
import { agreement, tape } from './playbook.ts';
import type { Coin, Playbook, Tape } from './playbook.ts';

export interface Finalist {
  by: string;
  playbook: Playbook;
  hypothesis: string;
  predicts: Revision['predicts'];
  /** Which round the playbook comes from: the revision, or the proposal when the revision was rejected. */
  from: 'proposal' | 'revision';
  /** Its calls on the past markets the agents were shown. */
  seen: Tape;
  /** Its calls on the newest markets, which no agent saw. */
  held: Tape;
}

/** One call to the skill's script: what was asked of Flagsmith, and the line it answered with. */
export interface Step { at: string; step: string; line: Record<string, unknown> }

export interface ArenaRecord {
  version: 1;
  name: string;
  created_at: string;
  model: string;
  brief: Brief;
  agents: typeof AGENTS;
  past: { from: number; cut: number; to: number; seen: number; held: number; up_seen: number; up_held: number };
  /** The fact sheet both agents were given, word for word. */
  facts: string;
  proposals: Partial<Record<AgentKey, Proposal>>;
  attacks: Partial<Record<AgentKey, Attack>>;
  revisions: Partial<Record<AgentKey, Revision>>;
  /** The playbooks that go into the experiment. An agent whose playbooks were all rejected is absent. */
  finalists: Partial<Record<AgentKey, Finalist>>;
  /** The control version, and how a coin does on the same past markets. */
  coin: { trader: Coin; seen: Tape; held: Tape };
  /** The share of held out markets on which the two finalists make the same call. */
  agreement: number | null;
  usage: { calls: number; seconds: number; tokens: { in: number; out: number }; cost: number };
  steps: Step[];
}

export const coinOf = (brief: Brief): Coin => ({ version: 1, kind: 'coin', seed: brief.coin.seed });
const share = (rows: { up: boolean }[]) => (rows.length ? Math.round((rows.filter(s => s.up).length / rows.length) * 1000) / 1000 : 0);

export async function debate(ask: Ask, brief: Brief, past: Past, model: string, say: (line: string) => void = () => {}): Promise<ArenaRecord> {
  const started = Date.now();
  let calls = 0;
  const counted: Ask = (system, prompt) => { calls++; return ask(system, prompt); };
  const both = async <T>(f: (k: AgentKey) => Promise<T | undefined>) => {
    const done = await Promise.all(AGENT_KEYS.map(f));
    return Object.fromEntries(AGENT_KEYS.flatMap((k, i) => (done[i] === undefined ? [] : [[k, done[i]]]))) as Partial<Record<AgentKey, T>>;
  };
  const facts = factSheet(past.seen, past.from, past.cut);

  say('Round 1: each agent writes a playbook.');
  const proposals = await both(k => propose(counted, k, brief, facts, past.seen));
  const standing = (k: AgentKey) => proposals[k]?.playbook ? (proposals[k] as Proposal & { playbook: Playbook }) : undefined;

  say('Round 2: each agent cross-examines the other.');
  const attacks = await both(async k => {
    const own = standing(k);
    const rival = standing(rivalOf(k));
    return own && rival ? attack(counted, k, brief, facts, own, rival) : undefined;
  });

  say('Round 3: each agent may revise once, then predicts the result.');
  const revisions = await both(async k => {
    const own = standing(k);
    const rival = standing(rivalOf(k));
    const against = attacks[rivalOf(k)];
    return own && rival && against ? revise(counted, k, brief, facts, past.seen, own, rival, against) : undefined;
  });

  say('The referee scores the final playbooks on the markets no agent saw.');
  const finalists: ArenaRecord['finalists'] = {};
  for (const k of AGENT_KEYS) {
    const first = standing(k);
    const last = revisions[k];
    const pick = last?.playbook ? { playbook: last.playbook, hypothesis: last.hypothesis, from: 'revision' as const }
      : first ? { playbook: first.playbook, hypothesis: first.hypothesis, from: 'proposal' as const } : null;
    if (pick) finalists[k] = { by: AGENTS[k].name, ...pick, predicts: last?.predicts ?? null, seen: tape(pick.playbook, past.seen), held: tape(pick.playbook, past.held) };
  }
  const coin = coinOf(brief);
  const [a, b] = [finalists.agent_a, finalists.agent_b];

  const spent = [...Object.values(proposals), ...Object.values(attacks), ...Object.values(revisions)];
  return {
    version: 1, name: brief.name, created_at: new Date(started).toISOString(), model, brief, agents: AGENTS,
    past: { from: past.from, cut: past.cut, to: past.to, seen: past.seen.length, held: past.held.length, up_seen: share(past.seen), up_held: share(past.held) },
    facts, proposals, attacks, revisions, finalists,
    coin: { trader: coin, seen: tape(coin, past.seen), held: tape(coin, past.held) },
    agreement: a && b ? Math.round(agreement(a.playbook, b.playbook, past.held) * 1000) / 1000 : null,
    usage: {
      calls, seconds: Math.round((Date.now() - started) / 1000),
      tokens: { in: spent.reduce((n, u) => n + u.tokens.in, 0), out: spent.reduce((n, u) => n + u.tokens.out, 0) },
      cost: Math.round(spent.reduce((n, u) => n + u.cost, 0) * 1000) / 1000,
    },
    steps: [],
  };
}

/** The plan the flagsmith-duel skill runs: the coin as control, the finalists as versions of one flag, and the rule. */
export function planOf(record: ArenaRecord, project?: number): Record<string, unknown> {
  const b = record.brief;
  const keys = AGENT_KEYS.filter(k => record.finalists[k]);
  return {
    name: b.name,
    ...(project ?? b.project ? { project: project ?? b.project } : {}),
    flag: b.flag,
    environment: b.environment,
    create_environment: true,
    hypothesis: b.goal,
    // The flag's value is the trader. The runner trades whatever Flagsmith serves, and nothing when the flag is off.
    control: JSON.stringify(record.coin.trader),
    versions: Object.fromEntries(keys.map(k => {
      const f = record.finalists[k]!;
      return [k, { by: `${f.by} (${AGENTS[k].stance.toLowerCase()})`, hypothesis: f.hypothesis, ...(f.predicts ? { predicts: f.predicts } : {}), value: JSON.stringify(f.playbook) }];
    })),
    split: Object.fromEntries(keys.map(k => [k, b.split[k]])),
    goal: { event: b.event.key, name: b.event.name },
    guardrails: b.guardrails.map(g => ({ event: g.key, name: g.name })),
    watch: b.watch.map(w => ({ event: w.key, name: w.name, aggregation: w.aggregation })),
    rule: b.rule,
    // The start and the rollout are a person's decisions: the skill then wants them typed on a terminal.
    protect: [b.environment],
  };
}
