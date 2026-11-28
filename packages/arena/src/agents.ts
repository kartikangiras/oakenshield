/*
 * The two agents and what each is asked. They get the same fact sheet and opposite convictions,
 * so the experiment tests two real ideas and not two samples of one. An agent's whole output is
 * one JSON object: it writes a playbook, attacks, revises and predicts, and can do nothing else.
 * It never sees a key, a market or the held out data.
 */
import { jsonIn } from '@oakenshield/duel';
import type { Ask, Reply } from '@oakenshield/duel';
import { ASSETS, LIMITS, OPS, SIGNALS, SIGNAL_NAMES, describe, parsePlaybook, review, tape } from './playbook.ts';
import type { Playbook, Problem, Situation, Tape } from './playbook.ts';
import type { Risk, Venue } from './runner.ts';

export type AgentKey = 'agent_a' | 'agent_b';
export const AGENT_KEYS: AgentKey[] = ['agent_a', 'agent_b'];
export const rivalOf = (k: AgentKey): AgentKey => (k === 'agent_a' ? 'agent_b' : 'agent_a');

export const AGENTS: Record<AgentKey, { name: string; stance: string; conviction: string }> = {
  agent_a: {
    name: 'Agent A',
    stance: 'Momentum',
    conviction: 'Short moves continue. Large orders are worked over minutes, and other traders chase what just moved, so the next five minutes tend to look like the last five. Trade with the recent move, and trust it more when it is broad, fresh and backed by volume.',
  },
  agent_b: {
    name: 'Agent B',
    stance: 'Reversal',
    conviction: 'Short moves overshoot. Most of a sharp five minute move is noise and thin liquidity, and it comes back once the pressure is gone. Trade against the recent move, hardest when it is stretched, late and unsupported by the wider market.',
  },
};

export interface Brief {
  name: string;
  /** The Flagsmith project, when the directory is not bound to one. */
  project?: number;
  flag: string;
  environment: string;
  /** One sentence: the hypothesis the experiment tests. */
  goal: string;
  event: { key: string; name: string };
  guardrails: { key: string; name: string }[];
  /** Numeric metrics Flagsmith reports next to the goal. They are shown, not judged. */
  watch: { key: string; name: string; aggregation: 'mean' | 'sum' | 'count' }[];
  /** The event sent for every trade that is placed. Usually the first guardrail. */
  placed: string;
  venue: Venue & { about: string };
  /** The control version's seed, published before the start. */
  coin: { seed: string };
  /** Hours of past markets the agents see, and the newest hours held back from them. */
  past: { hours: number; held_hours: number };
  rule: { min_per_arm: number; win_above: number; harm_below: number };
  split: Record<AgentKey, number>;
  /** The operator's loss limit for the runner. It is not shown to the agents and no playbook can read it. */
  risk?: Risk;
}

export interface Usage { ms: number; tokens: { in: number; out: number }; cost: number }
export interface Proposal extends Usage {
  playbook: Playbook | null;
  hypothesis: string;
  why: string;
  referee: Problem[];
  repaired?: boolean;
  /** How the playbook calls the markets the agents were shown. */
  seen?: Tape;
}
export interface Attack extends Usage { attacks: string[]; concedes: string }
export interface Revision extends Proposal { changed: string; predicts: Record<'control' | AgentKey, number> | null }

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const system = (k: AgentKey, b: Brief) => `You are ${AGENTS[k].name}, one of two AI agents competing to write the better trading playbook. Nobody is judging your prose. Live markets are.

THE MARKETS
${b.venue.about}

THE EXPERIMENT
Your playbook, your rival's playbook and a coin flip will trade live markets in a randomised experiment run by Flagsmith. Each market is given to exactly one of the three at random, so all three face the same conditions. Paper money: ${b.venue.stake} dollars a market, filled at the real asking price, settled by the real resolution. The measure is "${b.event.name}": how often the trader bought the side that won. A playbook wins only if Flagsmith gives it at least ${Math.round(b.rule.win_above * 100)}% chance to beat the coin after ${b.rule.min_per_arm} markets per trader. That rule is fixed before the start and the result is read once.

YOUR CONVICTION
${AGENTS[k].conviction}

THE PLAYBOOK LANGUAGE
A playbook is a JSON object: {"name":"...","rules":[{"when":[{"signal":"ret_5m","op":">","value":0.1}],"side":"up","why":"..."}],"otherwise":"down"}
- Rules are tried in order. The first rule whose conditions all hold makes the call. If none holds, the call is "otherwise".
- A rule may carry "assets": a list from ${ASSETS.join(', ')}. Leave it out for every asset.
- "op" is one of ${OPS.join(' ')}. "side" and "otherwise" are "up" or "down".
- 1 to ${LIMITS.rules} rules, 1 to ${LIMITS.conditions} conditions a rule, "name" up to ${LIMITS.name} characters, "why" up to ${LIMITS.why}.
- The signals, all measured one minute before the market opens:
${SIGNAL_NAMES.map(n => `  ${n} (${SIGNALS[n].min} to ${SIGNALS[n].max}): ${SIGNALS[n].about}`).join('\n')}

THE REFEREE
A referee runs every playbook on the past markets and rejects it when:
- it is not valid in the language above, or a number is outside its signal's range;
- it says the same side more than ${Math.round((1 - LIMITS.minSideShare) * 100)}% of the time (leaning on how often up won is a bet on a share that drifts from day to day, not a strategy);
- a rule fires fewer than ${LIMITS.minRuleFires} times (nobody can evaluate it).

Answer with one JSON object and nothing else.`;

const factsText = (facts: string) => `THE FACT SHEET
Both agents get the same one. It covers past markets only; the newest day is held back from both of you and the referee will score the final playbooks on it.
${facts}`;

/** A playbook with how it would have called the past markets, rule by rule. */
export function tapeText(p: Playbook, t: Tape): string {
  const lines = describe(p);
  return [
    `"${p.name}": right on ${pct(t.rate)} of ${t.markets} past markets, said up ${pct(t.up)} of the time.`,
    ...t.rules.map((r, i) => `  ${lines[i]}  [fired ${r.fired}, right ${r.fired ? pct(r.right / r.fired) : 'never'}]`),
  ].join('\n');
}

const str = (x: unknown, max: number) => (typeof x === 'string' ? x.trim().slice(0, max) : '');
const usage = (r: Reply): Usage => ({ ms: r.ms, tokens: r.tokens, cost: r.cost });
const add = (a: Usage, b: Usage): Usage => ({ ms: a.ms + b.ms, tokens: { in: a.tokens.in + b.tokens.in, out: a.tokens.out + b.tokens.out }, cost: a.cost + b.cost });

/** The referee: the language first, then what the playbook does on the past markets. */
export function referee(value: unknown, past: Situation[]): { playbook: Playbook | null; problems: Problem[]; seen?: Tape } {
  const { playbook, problems } = parsePlaybook(value);
  if (!playbook) return { playbook: null, problems };
  const found = review(playbook, past);
  return { playbook: found.length ? null : playbook, problems: found, seen: tape(playbook, past) };
}

/** Asks for a playbook and gives the agent one chance to repair what the referee rejects. */
async function draft<T extends Record<string, unknown>>(ask: Ask, sys: string, prompt: string, past: Situation[]): Promise<{ body: T; checked: ReturnType<typeof referee>; spent: Usage; repaired: boolean }> {
  let reply = await ask(sys, prompt);
  let spent = usage(reply);
  let body = (jsonIn(reply.text) ?? {}) as T;
  let checked = referee(body.playbook, past);
  let repaired = false;
  if (!checked.playbook) {
    repaired = true;
    reply = await ask(sys, `${prompt}

Your last answer was:
${JSON.stringify(body)}

The referee rejected its playbook:
${checked.problems.map(p => `- ${p.message}`).join('\n')}
${checked.seen ? `It was right on ${pct(checked.seen.rate)} of ${checked.seen.markets} past markets and said up ${pct(checked.seen.up)} of the time.` : ''}
Answer again in the same form with a playbook that passes.`);
    spent = add(spent, usage(reply));
    body = (jsonIn(reply.text) ?? {}) as T;
    checked = referee(body.playbook, past);
  }
  return { body, checked, spent, repaired };
}

export async function propose(ask: Ask, k: AgentKey, b: Brief, facts: string, past: Situation[]): Promise<Proposal> {
  const { body, checked, spent, repaired } = await draft<{ playbook?: unknown; hypothesis?: unknown; why?: unknown }>(ask, system(k, b), `${factsText(facts)}

Write your playbook. Answer with:
{"playbook": {...}, "hypothesis": "one sentence, at most 200 characters: what your playbook bets on", "why": "two sentences: what in the fact sheet you lean on, and what result would prove you wrong"}`, past);
  return { playbook: checked.playbook, hypothesis: str(body.hypothesis, 240), why: str(body.why, 480), referee: checked.problems, ...(repaired ? { repaired } : {}), ...(checked.seen ? { seen: checked.seen } : {}), ...spent };
}

export async function attack(ask: Ask, k: AgentKey, b: Brief, facts: string, own: Proposal & { playbook: Playbook }, rival: Proposal & { playbook: Playbook }): Promise<Attack> {
  const reply = await ask(system(k, b), `${factsText(facts)}

YOUR PLAYBOOK
${tapeText(own.playbook, own.seen!)}

YOUR RIVAL'S PLAYBOOK (${AGENTS[rivalOf(k)].name}, ${AGENTS[rivalOf(k)].stance.toLowerCase()})
${tapeText(rival.playbook, rival.seen!)}
Its claim: ${rival.hypothesis}

Cross-examine your rival's playbook. Say where it will lose live, naming rules and numbers. Answer with:
{"attacks": ["up to three, each at most 260 characters"], "concedes": "one sentence: what your rival got right"}`);
  const body = (jsonIn(reply.text) ?? {}) as { attacks?: unknown; concedes?: unknown };
  const attacks = (Array.isArray(body.attacks) ? body.attacks : []).map(a => str(a, 320)).filter(Boolean).slice(0, 3);
  return { attacks, concedes: str(body.concedes, 320), ...usage(reply) };
}

export async function revise(ask: Ask, k: AgentKey, b: Brief, facts: string, past: Situation[], own: Proposal & { playbook: Playbook }, rival: Proposal & { playbook: Playbook }, against: Attack): Promise<Revision> {
  const { body, checked, spent, repaired } = await draft<{ playbook?: unknown; changed?: unknown; hypothesis?: unknown; predicts?: unknown }>(ask, system(k, b), `${factsText(facts)}

YOUR PLAYBOOK
${tapeText(own.playbook, own.seen!)}
Your claim: ${own.hypothesis}

YOUR RIVAL'S PLAYBOOK (${AGENTS[rivalOf(k)].name}, ${AGENTS[rivalOf(k)].stance.toLowerCase()})
${tapeText(rival.playbook, rival.seen!)}

YOUR RIVAL'S ATTACKS ON YOURS
${against.attacks.map(a => `- ${a}`).join('\n') || '- none'}

You may revise your playbook once, or keep it as it is. The past markets flatter any playbook tuned on them; the live markets will not. Then predict the live result: the share of markets each trader will call right. Answer with:
{"playbook": {...}, "changed": "one sentence: what you changed and why, or why you changed nothing", "hypothesis": "one sentence, at most 200 characters", "predicts": {"control": 0.50, "agent_a": 0.50, "agent_b": 0.50}}`, past);
  const p = body.predicts as Record<string, unknown> | undefined;
  const share = (x: unknown) => (typeof x === 'number' && x >= 0 && x <= 1 ? Math.round(x * 1000) / 1000 : null);
  const predicts = p && share(p.control) !== null && share(p.agent_a) !== null && share(p.agent_b) !== null
    ? { control: share(p.control)!, agent_a: share(p.agent_a)!, agent_b: share(p.agent_b)! } : null;
  return {
    playbook: checked.playbook, hypothesis: str(body.hypothesis, 240) || own.hypothesis, why: own.why, changed: str(body.changed, 320), predicts,
    referee: checked.problems, ...(repaired ? { repaired } : {}), ...(checked.seen ? { seen: checked.seen } : {}), ...spent,
  };
}
