/*
 * One duel, up to the point where a person has to decide: two proposals, a cross-examination,
 * one revision each, and the referee's check on every screen. Nothing here touches Flagsmith.
 */
import { AGENTS, AGENT_KEYS, attack, propose, revise, rivalOf } from './agents.ts';
import type { AgentKey, Attack, Brief, Proposal, Revision } from './agents.ts';
import type { Ask } from './llm.ts';
import type { Screen } from './screen.ts';

export interface Finalist {
  by: string;
  screen: Screen;
  hypothesis: string;
  predicts: Revision['predicts'];
  /** Which round the screen comes from: the revision, or the proposal when the revision was rejected. */
  from: 'proposal' | 'revision';
}

/** One call to the skill's script: what was asked of Flagsmith, and the line it answered with. */
export interface Step { at: string; step: string; line: Record<string, unknown> }

export interface DuelRecord {
  version: 1;
  name: string;
  created_at: string;
  model: string;
  brief: Brief;
  agents: typeof AGENTS;
  proposals: Partial<Record<AgentKey, Proposal>>;
  attacks: Partial<Record<AgentKey, Attack>>;
  revisions: Partial<Record<AgentKey, Revision>>;
  /** The screens that go into the experiment. An agent whose screens were all rejected is absent. */
  finalists: Partial<Record<AgentKey, Finalist>>;
  usage: { calls: number; seconds: number; tokens: { in: number; out: number }; cost: number };
  steps: Step[];
}

export async function debate(ask: Ask, brief: Brief, model: string, say: (line: string) => void = () => {}): Promise<DuelRecord> {
  const started = Date.now();
  let calls = 0;
  const counted: Ask = (system, prompt) => { calls++; return ask(system, prompt); };
  const both = async <T>(f: (k: AgentKey) => Promise<T | undefined>) => {
    const done = await Promise.all(AGENT_KEYS.map(f));
    return Object.fromEntries(AGENT_KEYS.flatMap((k, i) => (done[i] === undefined ? [] : [[k, done[i]]]))) as Partial<Record<AgentKey, T>>;
  };

  say('Round 1: each agent writes a first screen.');
  const proposals = await both(k => propose(counted, k, brief));
  const standing = (k: AgentKey) => proposals[k]?.screen ? (proposals[k] as Proposal & { screen: Screen }) : undefined;

  say('Round 2: each agent cross-examines the other.');
  const attacks = await both(async k => {
    const own = standing(k);
    const rival = standing(rivalOf(k));
    return own && rival ? attack(counted, k, brief, own.screen, rival) : undefined;
  });

  say('Round 3: each agent may revise once, then predicts the result.');
  const revisions = await both(async k => {
    const own = standing(k);
    const rival = standing(rivalOf(k));
    const against = attacks[rivalOf(k)];
    return own && rival && against ? revise(counted, k, brief, own, rival, against) : undefined;
  });

  const finalists: DuelRecord['finalists'] = {};
  for (const k of AGENT_KEYS) {
    const first = standing(k);
    const last = revisions[k];
    if (last?.screen) finalists[k] = { by: AGENTS[k].name, screen: last.screen, hypothesis: last.hypothesis, predicts: last.predicts, from: 'revision' };
    else if (first) finalists[k] = { by: AGENTS[k].name, screen: first.screen, hypothesis: first.hypothesis, predicts: last?.predicts ?? null, from: 'proposal' };
  }

  const spent = [...Object.values(proposals), ...Object.values(attacks), ...Object.values(revisions)];
  return {
    version: 1, name: brief.name, created_at: new Date(started).toISOString(), model, brief, agents: AGENTS,
    proposals, attacks, revisions, finalists,
    usage: {
      calls, seconds: Math.round((Date.now() - started) / 1000),
      tokens: { in: spent.reduce((n, u) => n + u.tokens.in, 0), out: spent.reduce((n, u) => n + u.tokens.out, 0) },
      cost: Math.round(spent.reduce((n, u) => n + u.cost, 0) * 1000) / 1000,
    },
    steps: [],
  };
}

/** The plan the flagsmith-duel skill runs: the finalists as versions of one flag, and the rule. */
export function planOf(record: DuelRecord, project?: number): Record<string, unknown> {
  const b = record.brief;
  const keys = AGENT_KEYS.filter(k => record.finalists[k]);
  return {
    name: b.name,
    ...(project ? { project } : {}),
    flag: b.flag,
    environment: b.environment,
    create_environment: true,
    hypothesis: b.goal,
    control: 'control',
    versions: Object.fromEntries(keys.map(k => {
      const f = record.finalists[k]!;
      return [k, { by: `${f.by} (${AGENTS[k].stance.toLowerCase()})`, hypothesis: f.hypothesis, ...(f.predicts ? { predicts: f.predicts } : {}), value: f.screen }];
    })),
    split: Object.fromEntries(keys.map(k => [k, b.split[k]])),
    goal: { event: b.event.key, name: b.event.name },
    guardrails: b.guardrails.map(g => ({ event: g.key, name: g.name })),
    rule: b.rule,
    // The start and the rollout are a person's decisions: the skill then wants them typed on a terminal.
    protect: [b.environment],
  };
}
