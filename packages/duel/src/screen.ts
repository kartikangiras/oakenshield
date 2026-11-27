/*
 * A first screen, described as data.
 *
 * In a duel each agent's proposal is one of these, stored as the value of its variation on the
 * Flagsmith flag. The dashboard renders whatever the flag serves (apps/dashboard FirstScreen.tsx),
 * so shipping the winner is a flag change and there is no losing code to delete afterwards.
 *
 * The block list is deliberately small. An agent can change the words, the order and what is
 * shown, but not what the button does: every screen has exactly one `run` block, and the renderer
 * sends the same `check_run` event for all of them. That is what keeps the comparison fair.
 *
 * No Node imports here: the dashboard bundles this file.
 */

export type LinkTarget = 'playground' | 'experiments' | 'setup' | 'rules';

export type Block =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'steps'; items: string[] }
  /** The diff of one seeded pull request, as the playground shows it. */
  | { type: 'pull_request'; scenario: string; caption?: string }
  /** The one action. Runs Experiment Guard on a seeded pull request and shows the result below. */
  | { type: 'run'; label: string; scenario?: string }
  | { type: 'link'; label: string; to: LinkTarget };

export interface Screen { version: 1; blocks: Block[] }

/** What a screen may refer to. Anything else in the copy is an invented claim. */
export interface Facts {
  /** Ids of the seeded pull requests a screen can show or run. */
  scenarios: string[];
  /** Numbers the copy may state (rule count, scenario count and so on). Small counting numbers are always allowed. */
  numbers: number[];
}

export const LIMITS = {
  blocks: { min: 2, max: 7 },
  heading: 80,
  text: 240,
  step: 90,
  steps: { min: 2, max: 4 },
  label: 32,
  caption: 120,
  links: 2,
  /** All visible characters on the screen. */
  total: 700,
} as const;

export const LINK_TARGETS: LinkTarget[] = ['playground', 'experiments', 'setup', 'rules'];
/** The pull request a `run` block checks when the screen names none. */
export const DEFAULT_SCENARIO = 'rename-event';

/** Claims about other people. No agent has evidence for them. */
const UNSUPPORTED = /\b(trusted by|used by|loved by|customers?|testimonials?|award|guarantee[ds]?|#1)\b/i;
const MARKUP = /<[^>]*>|https?:|www\.|\]\(|[`*_]{2}/i;

export interface Problem { block: number | null; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Every visible string on the screen, in order. */
export function copyOf(screen: Screen): string[] {
  return screen.blocks.flatMap(b => {
    switch (b.type) {
      case 'heading': case 'text': return [b.text];
      case 'steps': return b.items;
      case 'pull_request': return b.caption ? [b.caption] : [];
      case 'run': case 'link': return [b.label];
    }
  });
}

export const wordCount = (screen: Screen) => copyOf(screen).join(' ').split(/\s+/).filter(Boolean).length;

/** The pull request the screen's `run` block checks. */
export function scenarioOf(screen: Screen): string {
  const run = screen.blocks.find(b => b.type === 'run');
  const shown = screen.blocks.find(b => b.type === 'pull_request');
  return (run?.type === 'run' && run.scenario) || (shown?.type === 'pull_request' && shown.scenario) || DEFAULT_SCENARIO;
}

/**
 * The referee's static check. Returns the problems found; an empty list means the screen may
 * enter a duel. Pass no facts to check the structure only (the dashboard does, before rendering).
 */
export function checkScreen(value: unknown, facts?: Facts): Problem[] {
  const problems: Problem[] = [];
  const add = (block: number | null, message: string) => { problems.push({ block, message }); };
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.blocks)) {
    return [{ block: null, message: 'Not a screen: expected {"version": 1, "blocks": [...]}.' }];
  }
  const blocks = value.blocks as unknown[];
  if (blocks.length < LIMITS.blocks.min || blocks.length > LIMITS.blocks.max) {
    add(null, `A screen has ${LIMITS.blocks.min} to ${LIMITS.blocks.max} blocks; this one has ${blocks.length}.`);
  }
  const count: Record<string, number> = {};
  const text = (i: number, what: string, v: unknown, max: number) => {
    if (!str(v)) return add(i, `${what} is empty.`);
    if (v.length > max) add(i, `${what} is ${v.length} characters; the limit is ${max}.`);
    if (MARKUP.test(v)) add(i, `${what} contains markup or a web address. Plain words only.`);
    if (UNSUPPORTED.test(v)) add(i, `${what} makes a claim nobody can back up ("${v.match(UNSUPPORTED)![0]}").`);
    if (facts) {
      for (const m of v.matchAll(/\d+(?:[.,]\d+)*/g)) {
        const n = Number(m[0].replace(/,/g, ''));
        if (!(Number.isInteger(n) && n >= 0 && n <= 3) && !facts.numbers.includes(n)) {
          add(i, `${what} states the number ${m[0]}, which is not in the fact sheet.`);
        }
      }
    }
  };
  const scenario = (i: number, v: unknown) => {
    if (!str(v)) return add(i, 'The pull request id is missing.');
    if (facts && !facts.scenarios.includes(v)) add(i, `There is no seeded pull request called "${v}".`);
  };
  blocks.forEach((b, i) => {
    if (!isRecord(b) || typeof b.type !== 'string') return add(i, 'Not a block.');
    count[b.type] = (count[b.type] ?? 0) + 1;
    switch (b.type) {
      case 'heading': text(i, 'The heading', b.text, LIMITS.heading); break;
      case 'text': text(i, 'The paragraph', b.text, LIMITS.text); break;
      case 'steps':
        if (!Array.isArray(b.items) || b.items.length < LIMITS.steps.min || b.items.length > LIMITS.steps.max) {
          add(i, `A list of steps has ${LIMITS.steps.min} to ${LIMITS.steps.max} items.`);
        } else b.items.forEach((s, n) => text(i, `Step ${n + 1}`, s, LIMITS.step));
        break;
      case 'pull_request':
        scenario(i, b.scenario);
        if (b.caption !== undefined) text(i, 'The caption', b.caption, LIMITS.caption);
        break;
      case 'run':
        text(i, 'The button label', b.label, LIMITS.label);
        if (b.scenario !== undefined) scenario(i, b.scenario);
        break;
      case 'link':
        text(i, 'The link label', b.label, LIMITS.label);
        if (!LINK_TARGETS.includes(b.to as LinkTarget)) add(i, `A link goes to one of: ${LINK_TARGETS.join(', ')}.`);
        break;
      default: add(i, `Unknown block type "${b.type}".`);
    }
  });
  // The fairness rule: one action, the same one in every version.
  if ((count.run ?? 0) !== 1) add(null, `A screen has exactly one run block (the action that is counted); this one has ${count.run ?? 0}.`);
  if ((count.heading ?? 0) > 1) add(null, 'A screen has at most one heading.');
  if ((count.pull_request ?? 0) > 1) add(null, 'A screen shows at most one pull request.');
  if ((count.link ?? 0) > LIMITS.links) add(null, `A screen has at most ${LIMITS.links} links.`);
  if (problems.length === 0) {
    const s = value as unknown as Screen;
    const shown = s.blocks.find(b => b.type === 'pull_request');
    const run = s.blocks.find(b => b.type === 'run');
    if (shown?.type === 'pull_request' && run?.type === 'run' && run.scenario && run.scenario !== shown.scenario) {
      add(null, 'The button runs a different pull request from the one on screen.');
    }
    const total = copyOf(s).join('').length;
    if (total > LIMITS.total) add(null, `The screen has ${total} characters of copy; the limit is ${LIMITS.total}.`);
  }
  return problems;
}

/** Reads what a flag serves. Returns the screen, or null for the control value or anything invalid. */
export function parseScreen(value: unknown): Screen | null {
  if (typeof value !== 'string' || !value.trimStart().startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return checkScreen(parsed).length === 0 ? parsed as Screen : null;
  } catch {
    return null;
  }
}
