/*
 * The trade log: one JSON line per thing that happened, appended and never rewritten. Everything
 * the page shows is computed from these lines, and so is anyone's check of the result.
 */
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Asset, Side, Signals } from './playbook.ts';

/** 'experiment': the market was enrolled and counts. 'after': traded once the experiment was over. 'dry': no Flagsmith. */
export type Phase = 'experiment' | 'after' | 'dry';

export interface OpenLine {
  t: 'open'; at: string; slug: string; asset: Asset; start: number; end: number; condition: string;
  arm: string; phase: Phase; side: Side; rule: number; signals: Signals;
  price: number; top: number; shares: number; cost: number; fee: number;
}
export interface SettleLine { t: 'settle'; at: string; slug: string; winner: Side; won: boolean; payout: number; profit: number }
/** A market that was not traded, decided before any version was asked for it. */
export interface SkipLine { t: 'skip'; at: string; slug: string; why: string }
/** A trade whose market never resolved in time. It counts for nobody. */
export interface VoidLine { t: 'void'; at: string; slug: string; why: string }
/** The settled trades whose events Flagsmith has acknowledged. */
export interface ReportedLine { t: 'reported'; at: string; slugs: string[] }
/** The loss limit the runner trades under: written before its first trade and whenever it changes. */
export interface LimitLine { t: 'limit'; at: string; max_loss: number; over: number }
/** The loss limit was reached. Nothing new is traded until a person restarts the arena. */
export interface HaltLine { t: 'halt'; at: string; lost: number; max_loss: number; over: number }
/** A person restarted the arena after a halt. Losses are counted from here again. */
export interface ResumeLine { t: 'resume'; at: string; halted_at: string; by: string }
export type Line = OpenLine | SettleLine | SkipLine | VoidLine | ReportedLine | LimitLine | HaltLine | ResumeLine;

export interface Trade extends OpenLine { settle?: SettleLine; void?: VoidLine; reported?: boolean }

export class Ledger {
  readonly file: string;
  readonly lines: Line[] = [];
  readonly trades = new Map<string, Trade>();
  skipped = 0;
  /** The loss limit in force, when there is one. */
  limit: LimitLine | null = null;
  /** Set while the loss limit holds the arena. */
  halted: HaltLine | null = null;
  /** When a person last restarted the arena; empty when nobody has. */
  since = '';

  constructor(dir: string) {
    this.file = join(dir, 'trades.jsonl');
    if (existsSync(this.file)) {
      for (const text of readFileSync(this.file, 'utf8').split('\n')) {
        if (!text.trim()) continue;
        try { this.take(JSON.parse(text) as Line); } catch { /* a line cut short by a crash */ }
      }
    }
  }

  private take(line: Line): void {
    this.lines.push(line);
    if (line.t === 'open') this.trades.set(line.slug, { ...line });
    else if (line.t === 'skip') this.skipped++;
    else if (line.t === 'reported') for (const s of line.slugs) { const tr = this.trades.get(s); if (tr) tr.reported = true; }
    else if (line.t === 'limit') this.limit = line;
    else if (line.t === 'halt') this.halted = line;
    else if (line.t === 'resume') { this.halted = null; this.since = line.at; }
    else { const tr = this.trades.get(line.slug); if (tr) { if (line.t === 'settle') tr.settle = line; else tr.void = line; } }
  }

  add(line: Line): void {
    appendFileSync(this.file, JSON.stringify(line) + '\n');
    this.take(line);
  }

  /** Trades still waiting for their market to resolve. */
  pending(): Trade[] { return [...this.trades.values()].filter(t => !t.settle && !t.void); }
  /** Settled trades Flagsmith has not been told about yet. */
  unreported(): Trade[] { return [...this.trades.values()].filter(t => t.settle && !t.reported && t.phase === 'experiment'); }
  /** Paper dollars lost on the last `over` markets settled since the arena was last restarted. Negative when they made money. */
  lost(over: number): number {
    const settled = [...this.trades.values()].filter(t => t.settle && t.settle.at > this.since)
      .sort((a, b) => a.settle!.at.localeCompare(b.settle!.at) || a.slug.localeCompare(b.slug));
    return -cents(settled.slice(-over).reduce((n, t) => n + t.settle!.profit, 0)) || 0;
  }
}

/** `shares` is what the settled trades bought: (staked + fees) / shares is the share of calls that must be right to break even. */
export interface Totals { markets: number; settled: number; won: number; staked: number; fees: number; shares: number; profit: number }
export interface FeedRow {
  slug: string; asset: Asset; start: number; arm: string; phase: Phase; side: Side; rule: number; price: number;
  winner?: Side; won?: boolean; profit?: number;
}
/** Everything the page needs, small enough to send whole after every market. */
export interface ArenaState {
  version: 1;
  updated_at: string;
  /** Always true: no order is ever placed. */
  paper: true;
  order: string[];
  arms: Record<string, Totals>;
  /** Trades made after the experiment ended, with whatever the flag served then. */
  after: Totals;
  /** One character per settled market of the experiment, in the order they settled: arm index x 2, plus 1 for a win. */
  replay: string;
  /** Running profit per arm, one point per five minute window. */
  curve: { at: number[]; profit: Record<string, number[]> };
  feed: FeedRow[];
  open: number;
  skipped: number;
  voided: number;
  first?: string;
  last?: string;
  /** The loss limit, what the last `over` settled markets have lost against it, and when it stopped the arena. */
  risk?: { max_loss: number; over: number; lost: number; halted_at?: string };
  /** Something the runner wants a reader to know, such as the flag being off. */
  note?: string;
}

const zero = (): Totals => ({ markets: 0, settled: 0, won: 0, staked: 0, fees: 0, shares: 0, profit: 0 });
const cents = (x: number) => Math.round(x * 100) / 100;

/** The page's view of a set of trades. `order` lists the arms the way the plan does, control first. */
export function summarize(trades: Iterable<Trade>, order: string[], skipped = 0, now = new Date()): ArenaState {
  const all = [...trades].sort((a, b) => a.start - b.start || a.slug.localeCompare(b.slug));
  const arms: Record<string, Totals> = Object.fromEntries(order.map(k => [k, zero()]));
  const after = zero();
  let voided = 0;
  const windows = new Map<number, Record<string, number>>();
  for (const t of all) {
    if (t.void) { voided++; continue; }
    const into = t.phase === 'after' ? after : (arms[t.arm] ??= zero());
    into.markets++;
    if (!t.settle) continue;
    into.settled++;
    if (t.settle.won) into.won++;
    into.staked += t.cost; into.fees += t.fee; into.shares += t.shares; into.profit += t.settle.profit;
    if (t.phase !== 'after') {
      const w = windows.get(t.start) ?? {};
      w[t.arm] = (w[t.arm] ?? 0) + t.settle.profit;
      windows.set(t.start, w);
    }
  }
  for (const x of [...Object.values(arms), after]) { x.staked = cents(x.staked); x.fees = cents(x.fees); x.shares = cents(x.shares); x.profit = cents(x.profit); }
  const keys = Object.keys(arms);
  const at = [...windows.keys()].sort((a, b) => a - b);
  const running = Object.fromEntries(keys.map(k => [k, 0]));
  const profit: Record<string, number[]> = Object.fromEntries(keys.map(k => [k, []]));
  for (const w of at) for (const k of keys) { running[k]! += windows.get(w)![k] ?? 0; profit[k]!.push(cents(running[k]!)); }
  const settled = all.filter(t => t.settle && t.phase !== 'after').sort((a, b) => a.settle!.at.localeCompare(b.settle!.at) || a.slug.localeCompare(b.slug));
  const replay = settled.map(t => (keys.indexOf(t.arm) * 2 + (t.settle!.won ? 1 : 0)).toString(36)).join('');
  const feed = all.filter(t => !t.void).slice(-60).reverse().map((t): FeedRow => ({
    slug: t.slug, asset: t.asset, start: t.start, arm: t.arm, phase: t.phase, side: t.side, rule: t.rule, price: t.price,
    ...(t.settle ? { winner: t.settle.winner, won: t.settle.won, profit: t.settle.profit } : {}),
  }));
  return {
    version: 1, updated_at: now.toISOString(), paper: true, order: keys, arms, after, replay, curve: { at, profit }, feed,
    open: all.filter(t => !t.settle && !t.void).length, skipped, voided,
    ...(all.length ? { first: all[0]!.at, last: all.at(-1)!.at } : {}),
  };
}

/** Writes a file whole or not at all, so a reader never sees half of it. */
export function writeAtomic(path: string, value: unknown): void {
  writeFileSync(`${path}.tmp`, JSON.stringify(value) + '\n');
  renameSync(`${path}.tmp`, path);
}
