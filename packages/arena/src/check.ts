/*
 * The arena's own reading of its trade log. Markets that open in the same five minutes move
 * together, so they are not independent the way visitors are. This reading keeps every window
 * whole: it draws windows, not markets, and counts how often each playbook beats the coin.
 * It is a second opinion beside Flagsmith's result, never the verdict.
 */
import { createHash } from 'node:crypto';
import type { Trade } from './ledger.ts';

export interface ArenaCheck {
  version: 1;
  computed_at: string;
  /** One sentence on how it was computed. */
  method: string;
  draws: number;
  /** Five minute windows with a settled market of the experiment. */
  windows: number;
  markets: number;
  /** `break_even` is the share of calls the arm needed right to lose nothing, at the prices and fees it paid. */
  arms: Record<string, { markets: number; won: number; rate: number; break_even: number; profit: number }>;
  /** Each challenger against the control. `diff`, `low` and `high` are differences in win rate; `low` and `high` hold 95% of the draws. */
  against_control: Record<string, { diff: number; low: number; high: number; chance_to_win: number }>;
  /** Flagsmith's chance to win for the same arm, copied from the verdict. */
  flagsmith: Record<string, number | null>;
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** A small seeded generator, so anyone who runs the check on the same log gets the same numbers. */
function seeded(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32BE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** `order` lists the arms the way the plan does, control first. */
export function check(trades: Iterable<Trade>, order: string[], flagsmith: Record<string, number | null> = {}, draws = 10_000, seed = 'oakenshield-arena-check', now = new Date()): ArenaCheck {
  const settled = [...trades].filter(t => t.phase === 'experiment' && t.settle && !t.void && order.includes(t.arm));
  const [control = 'control', ...challengers] = order;
  const index = new Map(order.map((k, i) => [k, i]));
  // One row per window: for every arm, how many markets it had there and how many it called right.
  const byWindow = new Map<number, { n: number[]; won: number[] }>();
  const arms: ArenaCheck['arms'] = Object.fromEntries(order.map(k => [k, { markets: 0, won: 0, rate: 0, break_even: 0, profit: 0 }]));
  const paid = order.map(() => 0), shares = order.map(() => 0);
  for (const t of settled) {
    const i = index.get(t.arm)!;
    const w = byWindow.get(t.start) ?? { n: order.map(() => 0), won: order.map(() => 0) };
    w.n[i]!++;
    if (t.settle!.won) w.won[i]!++;
    byWindow.set(t.start, w);
    const a = arms[t.arm]!;
    a.markets++;
    if (t.settle!.won) a.won++;
    a.profit += t.settle!.profit;
    paid[i]! += t.cost + t.fee;
    shares[i]! += t.shares;
  }
  order.forEach((k, i) => {
    const a = arms[k]!;
    a.rate = a.markets ? round(a.won / a.markets) : 0;
    a.break_even = shares[i]! ? round(paid[i]! / shares[i]!) : 0;
    a.profit = round(a.profit, 2);
  });

  const rows = [...byWindow.values()];
  const next = seeded(seed);
  const diffs: number[][] = challengers.map(() => []);
  for (let d = 0; d < draws && rows.length; d++) {
    const n = order.map(() => 0), won = order.map(() => 0);
    for (let j = 0; j < rows.length; j++) {
      const r = rows[Math.floor(next() * rows.length)]!;
      for (let i = 0; i < order.length; i++) { n[i]! += r.n[i]!; won[i]! += r.won[i]!; }
    }
    if (!n[0]) continue;
    challengers.forEach((_, c) => { if (n[c + 1]) diffs[c]!.push(won[c + 1]! / n[c + 1]! - won[0]! / n[0]!); });
  }
  const against: ArenaCheck['against_control'] = {};
  challengers.forEach((k, c) => {
    const all = diffs[c]!.sort((a, b) => a - b);
    if (!all.length) return;
    const at = (p: number) => all[Math.min(all.length - 1, Math.floor(p * all.length))]!;
    // A draw that ties counts as half a win, so two identical arms come out at one half.
    const wins = all.reduce((s, x) => s + (x > 0 ? 1 : x === 0 ? 0.5 : 0), 0);
    against[k] = { diff: round(arms[k]!.rate - arms[control]!.rate), low: round(at(0.025)), high: round(at(0.975)), chance_to_win: round(wins / all.length) };
  });

  return {
    version: 1, computed_at: now.toISOString(),
    method: `${draws} draws of whole five minute windows, with replacement, from the settled markets of the experiment; each draw compares every playbook's share of right calls with the coin's.`,
    draws, windows: rows.length, markets: settled.length, arms, against_control: against,
    flagsmith: Object.fromEntries(challengers.map(k => [k, flagsmith[k] ?? null])),
  };
}
