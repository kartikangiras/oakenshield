/*
 * The two agents and what each is asked. They get the same brief and opposite convictions, so
 * the experiment tests two real ideas and not two samples of one. An agent's whole output is one
 * JSON object: it proposes, attacks, revises and predicts, and can do nothing else.
 */
import { LIMITS, LINK_TARGETS, checkScreen, copyOf } from './screen.ts';
import type { Facts, Problem, Screen } from './screen.ts';
import { jsonIn } from './llm.ts';
import type { Ask, Reply } from './llm.ts';

export type AgentKey = 'agent_a' | 'agent_b';
export const AGENT_KEYS: AgentKey[] = ['agent_a', 'agent_b'];
export const rivalOf = (k: AgentKey): AgentKey => (k === 'agent_a' ? 'agent_b' : 'agent_a');

export const AGENTS: Record<AgentKey, { name: string; stance: string; conviction: string }> = {
  agent_a: {
    name: 'Agent A',
    stance: 'Cut',
    conviction: 'People decide in seconds. Every extra word, step and choice costs visitors. The best first screen is the shortest honest path to the action: say the one thing that matters and put the button under it.',
  },
  agent_b: {
    name: 'Agent B',
    stance: 'Guide',
    conviction: 'People do not press what they do not understand. A visitor who can see the problem and knows what the button will do presses it; a visitor who is rushed leaves. The best first screen shows the problem and walks the visitor to the action.',
  },
};

export interface Brief {
  name: string;
  flag: string;
  environment: string;
  /** One sentence: what should happen more often, and for whom. */
  goal: string;
  event: { key: string; name: string };
  guardrails: { key: string; name: string }[];
  product: string;
  today: string;
  visitors: string;
  /** What a screen may claim. Anything else is rejected by the referee. */
  facts: Facts & { statements: string[]; scenarioTitles: Record<string, string> };
  rule: { min_per_arm: number; win_above: number; harm_below: number };
  split: Record<AgentKey, number>;
}

export interface Usage { ms: number; tokens: { in: number; out: number }; cost: number }
export interface Proposal extends Usage { screen: Screen | null; hypothesis: string; why: string; referee: Problem[]; repaired?: boolean }
export interface Attack extends Usage { attacks: string[]; concedes: string }
export interface Revision extends Proposal { changed: string; predicts: Record<'control' | AgentKey, number> | null }

const system = (k: AgentKey) => `You are ${AGENTS[k].name}, one of two AI agents competing to improve the first screen a new visitor sees in a web app. Your screen, your rival's screen and today's screen will run against each other in a live three-way experiment. The winner is decided by what visitors do, measured by Flagsmith, under a rule fixed before the start. Nobody is judging your prose, so write for the visitor.

Your conviction: ${AGENTS[k].conviction}

A screen is a JSON object {"version":1,"blocks":[...]} built only from these blocks:
- {"type":"heading","text":"..."}: the page title (at most one, ${LIMITS.heading} characters)
- {"type":"text","text":"..."}: a paragraph (${LIMITS.text} characters)
- {"type":"steps","items":["...","..."]}: a numbered list (${LIMITS.steps.min} to ${LIMITS.steps.max} items, ${LIMITS.step} characters each)
- {"type":"pull_request","scenario":"<id>","caption":"..."}: shows that sample pull request's diff (at most one; caption ${LIMITS.caption} characters)
- {"type":"run","label":"...","scenario":"<id>"}: the one button (label ${LIMITS.label} characters). Pressing it runs the check on that sample pull request and shows the verdict below. This press is the measured event.
- {"type":"link","label":"...","to":"${LINK_TARGETS.join('|')}"}: a secondary button to another page (at most ${LIMITS.links})

A referee checks every screen and rejects it if it breaks a rule:
- ${LIMITS.blocks.min} to ${LIMITS.blocks.max} blocks and at most ${LIMITS.total} characters of copy in all.
- Exactly one "run" block. You cannot remove, rename or duplicate the measured event.
- If the screen shows a pull request, the run button must check that same one.
- Plain text only: no markup, no web addresses.
- Only claims the fact sheet supports. No customers, testimonials, awards or guarantees. No number above 3 unless the fact sheet has it.

Answer with one JSON object and nothing else.`;

const briefText = (b: Brief) => `THE PRODUCT
${b.product}

TODAY'S FIRST SCREEN (the control version)
${b.today}

THE GOAL
${b.goal}
Measured event: ${b.event.key} (${b.event.name}).
Must not get worse: ${b.guardrails.map(g => `${g.key} (${g.name})`).join(', ') || 'nothing else is measured'}.

WHO VISITS
${b.visitors}

FACT SHEET (all you may claim)
${b.facts.statements.map(s => `- ${s}`).join('\n')}
Sample pull requests you may show (id: what it is):
${Object.entries(b.facts.scenarioTitles).map(([id, title]) => `- ${id}: ${title}`).join('\n')}`;

const show = (s: Screen | null) => JSON.stringify(s);
/** A string an agent wrote, held to a length. If it has to be cut, it is cut after a whole sentence where there is one. */
const str = (v: unknown, max = 600) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > max / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
};
const usage = (r: Reply): Usage => ({ ms: r.ms, tokens: r.tokens, cost: r.cost });
const addUsage = (a: Usage, b: Usage): Usage => ({ ms: a.ms + b.ms, tokens: { in: a.tokens.in + b.tokens.in, out: a.tokens.out + b.tokens.out }, cost: a.cost + b.cost });

function screenIn(value: unknown, facts: Facts): { screen: Screen | null; referee: Problem[] } {
  const referee = checkScreen(value, facts);
  return { screen: referee.length ? null : (value as Screen), referee };
}

/** Sends a rejected screen back with the referee's reasons. One chance. */
async function repair(ask: Ask, k: AgentKey, b: Brief, rejected: unknown, problems: Problem[]): Promise<{ screen: Screen | null; referee: Problem[]; usage: Usage }> {
  const r = await ask(system(k), `${briefText(b)}

The referee rejected your screen:
${JSON.stringify(rejected)}

Reasons:
${problems.map(p => `- ${p.block === null ? '' : `block ${p.block + 1}: `}${p.message}`).join('\n')}

Fix every reason and keep your idea. Answer as {"screen": {...}}.`);
  const o = jsonIn(r.text) as { screen?: unknown } | null;
  return { ...screenIn(o?.screen, b.facts), usage: usage(r) };
}

async function refereed(ask: Ask, k: AgentKey, b: Brief, candidate: unknown, first: Usage) {
  let { screen, referee } = screenIn(candidate, b.facts);
  let total = first;
  let repaired = false;
  if (!screen) {
    const again = await repair(ask, k, b, candidate, referee);
    total = addUsage(total, again.usage);
    // The first rejection stays on the record even when the repair passes.
    if (again.screen) { screen = again.screen; repaired = true; } else referee = [...referee, ...again.referee];
  }
  return { screen, referee, repaired, usage: total };
}

export async function propose(ask: Ask, k: AgentKey, b: Brief): Promise<Proposal> {
  const r = await ask(system(k), `${briefText(b)}

Write your first screen. Answer as:
{"screen": {...}, "hypothesis": "If ..., then ..., because ... (one sentence)", "why": "the reasoning behind your choices, two sentences at most"}`);
  const o = (jsonIn(r.text) ?? {}) as Record<string, unknown>;
  const checked = await refereed(ask, k, b, o.screen, usage(r));
  return { screen: checked.screen, referee: checked.referee, ...(checked.repaired ? { repaired: true } : {}), hypothesis: str(o.hypothesis), why: str(o.why), ...checked.usage };
}

export async function attack(ask: Ask, k: AgentKey, b: Brief, own: Screen, rival: Proposal): Promise<Attack> {
  const r = await ask(system(k), `${briefText(b)}

YOUR SCREEN
${show(own)}

YOUR RIVAL'S SCREEN (${AGENTS[rivalOf(k)].name})
${show(rival.screen)}
Their hypothesis: ${rival.hypothesis}

Cross-examine the rival's screen. Say where it will lose visitors and why, as concretely as you can: name the block and the visitor. Then say what it does better than yours, honestly. Answer as:
{"attacks": ["...", "..."], "concedes": "..."}
Three attacks at most, each one or two sentences (300 characters at most). The concession is one sentence.`);
  const o = (jsonIn(r.text) ?? {}) as Record<string, unknown>;
  return { attacks: Array.isArray(o.attacks) ? o.attacks.map(a => str(a)).filter(Boolean).slice(0, 3) : [], concedes: str(o.concedes), ...usage(r) };
}

export async function revise(ask: Ask, k: AgentKey, b: Brief, own: Proposal & { screen: Screen }, rival: Proposal, against: Attack): Promise<Revision> {
  const r = await ask(system(k), `${briefText(b)}

YOUR SCREEN
${show(own.screen)}
Your hypothesis: ${own.hypothesis}

YOUR RIVAL'S SCREEN (${AGENTS[rivalOf(k)].name})
${show(rival.screen)}

YOUR RIVAL'S ATTACK ON YOUR SCREEN
${against.attacks.map(a => `- ${a}`).join('\n') || '- (none)'}

You may revise your screen once, or keep it. Take what is right in the attack and ignore what is not; stay true to your conviction. This is the version that goes into the experiment.

Then predict the experiment: for each of the three versions, the share of first-time visitors who will press the run button (0 to 1). Your rival may also revise, so predict for their screen as shown. Predictions are scored against the measured result, so say what you believe, not what you hope.

Answer as:
{"screen": {...}, "changed": "what you changed and why, or 'nothing' and why (two sentences at most)", "hypothesis": "If ..., then ..., because ... (one sentence)", "predicts": {"control": 0.0, "agent_a": 0.0, "agent_b": 0.0}}`);
  const o = (jsonIn(r.text) ?? {}) as Record<string, unknown>;
  const checked = await refereed(ask, k, b, o.screen, usage(r));
  const p = o.predicts as Record<string, unknown> | undefined;
  const rate = (v: unknown) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : null);
  const predicts = p && rate(p.control) !== null && rate(p.agent_a) !== null && rate(p.agent_b) !== null
    ? { control: p.control as number, agent_a: p.agent_a as number, agent_b: p.agent_b as number } : null;
  return {
    screen: checked.screen, referee: checked.referee, ...(checked.repaired ? { repaired: true } : {}),
    changed: str(o.changed), hypothesis: str(o.hypothesis) || own.hypothesis, why: own.why, predicts, ...checked.usage,
  };
}

/** A screen as a reader sees it, for transcripts and terminals. */
export const outline = (s: Screen): string => copyOf(s).join(' / ');
