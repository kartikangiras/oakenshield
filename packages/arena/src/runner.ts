/*
 * The runner: every five minutes, for every asset, one live market. It reads the prices, asks the
 * desk which version trades this market, makes that version's call, fills it on paper from the
 * real order book, and five minutes later settles it against Polymarket's own resolution.
 *
 * The order of those steps is the experiment's hygiene. A market is dropped for missing prices
 * or a thin book before any version is asked for it, so a skip cannot favour one. After a version
 * is asked, the market counts whatever happens.
 */
import { join } from 'node:path';
import type { Desk } from './desk.ts';
import { Ledger, summarize, writeAtomic } from './ledger.ts';
import type { ArenaState, Phase, Trade } from './ledger.ts';
import { asks, findMarket, resolution, slugOf } from './market.ts';
import type { Market } from './market.ts';
import { fill, settle } from './paper.ts';
import { decide, parseTrader } from './playbook.ts';
import type { Asset } from './playbook.ts';
import { LOOKBACK_MINUTES, WINDOW, signalsAt } from './signals.ts';
import type { Candle } from './signals.ts';
import { candles } from './spot.ts';

export interface Venue {
  assets: Asset[];
  /** Paper dollars spent on every market. */
  stake: number;
  /** A market is skipped when either side would cost more than this per share: it is no longer an even bet. */
  max_price: number;
}
export interface EventNames { placed: string; won: string; profit?: string }
/** The loss limit: `max_loss` paper dollars over the last `over` settled markets, all versions together. */
export interface Risk { max_loss: number; over: number }

export interface RunnerOptions {
  dir: string;
  desk: Desk;
  venue: Venue;
  /** The arms the way the plan lists them, control first. */
  order: string[];
  events: EventNames;
  /** True for a rehearsal without Flagsmith. */
  dry?: boolean;
  /** Stop after this many windows. */
  windows?: number;
  /**
   * The sample every version needs. Once each has it the runner opens nothing more until
   * `decided` says the result was read, so the experiment ends at the size fixed in advance.
   */
  target?: number;
  decided?: () => boolean;
  /**
   * The circuit breaker. Once the limit is reached the runner opens nothing for any version, so
   * the halt cannot favour one, and it stays that way through restarts of the runner until
   * `restarted` names the person who approved trading again after that halt.
   */
  risk?: Risk;
  restarted?: (haltedAt: string) => string | null;
  say?: (line: string) => void;
  /** Called with the new state after every change, on top of the state file. */
  publish?: (state: ArenaState) => Promise<void>;
  signal?: AbortSignal;
}

/**
 * Seconds before a market opens that its trade is decided. The newest minute a playbook reads
 * closes a minute before the open; ten seconds later the order books are still deep and close to
 * even. Nearer to the open they thin out and lean.
 */
const LEAD = 50;
/** A quote taken later than this after the open is not an opening trade any more. */
const LATE = 40;
/** Polymarket resolves about 20 seconds after the window ends. */
const RESOLVE_AFTER = 15;
const GIVE_UP_AFTER = 6 * 3600;
/** An event Flagsmith has not confirmed after this long is sent again. */
const RESEND_AFTER = 180;

const clock = () => Date.now() / 1000;
const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(done => {
  if (signal?.aborted) return done();
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
});

export async function run(o: RunnerOptions): Promise<void> {
  const say = o.say ?? (() => {});
  const ledger = new Ledger(o.dir);
  const markets = new Map<string, Market | null>();
  let note = '';
  const stopped = () => o.signal?.aborted === true;
  const risk = o.risk;
  if (risk && (ledger.limit?.max_loss !== risk.max_loss || ledger.limit.over !== risk.over)) {
    ledger.add({ t: 'limit', at: new Date().toISOString(), max_loss: risk.max_loss, over: risk.over });
  }

  let published = 0;
  const publish = async () => {
    published = clock();
    const state: ArenaState = {
      ...summarize(ledger.trades.values(), o.order, ledger.skipped),
      ...(risk ? { risk: { max_loss: risk.max_loss, over: risk.over, lost: ledger.lost(risk.over), ...(ledger.halted ? { halted_at: ledger.halted.at } : {}) } } : {}),
      ...(note ? { note } : {}),
    };
    writeAtomic(join(o.dir, 'state.json'), state);
    await o.publish?.(state).catch(() => {});
  };
  /** The page shows when the runner was last heard from, so it speaks up even when nothing changed. */
  const beat = async () => { if (clock() - published > 60) await publish(); };

  /** The circuit breaker: looks at the loss limit after every settlement. Once tripped it stays tripped. */
  const trip = () => {
    if (!risk || ledger.halted) return;
    const lost = ledger.lost(risk.over);
    if (lost >= risk.max_loss) ledger.add({ t: 'halt', at: new Date().toISOString(), lost, max_loss: risk.max_loss, over: risk.over });
  };

  const market = async (asset: Asset, start: number): Promise<Market | null> => {
    const slug = slugOf(asset, start);
    if (!markets.has(slug)) {
      try { markets.set(slug, await findMarket(asset, start)); } catch { return null; } // not cached: asked again later
    }
    return markets.get(slug) ?? null;
  };

  const sent = new Map<string, number>();
  const fresh = (key: string) => {
    const last = sent.get(key);
    if (last !== undefined && clock() - last < RESEND_AFTER) return false;
    sent.set(key, clock());
    return true;
  };
  const send = (name: string, slug: string, value?: number, again = false) => {
    if (again || (!o.desk.acked(name, slug) && fresh(`${name}|${slug}`))) o.desk.event(name, slug, value);
  };
  /** The events one trade owes Flagsmith: that it was placed, that it won, and what it made. */
  const owed = (t: Trade): [string, number?][] => [
    [o.events.placed],
    ...(t.settle?.won ? [[o.events.won] as [string]] : []),
    ...(t.settle && o.events.profit ? [[o.events.profit, t.settle.profit] as [string, number]] : []),
  ];
  /** Tells Flagsmith how settled trades went, and notes the ones it has confirmed. */
  const report = async () => {
    const due = ledger.unreported();
    if (!due.length) return;
    for (const t of due) {
      // Flagsmith counts an outcome only after the market's exposure. When that never arrived (a
      // lost batch, or a runner that was stopped), ask for the seat again and send it all in order.
      const again = !o.desk.exposed(t.slug) && fresh(`seat|${t.slug}`);
      if (again) await o.desk.seat(t.slug).catch(() => {});
      for (const [name, value] of owed(t)) send(name, t.slug, value, again);
    }
    await o.desk.flush();
    const done = due.filter(t => owed(t).every(([name]) => o.desk.acked(name, t.slug)));
    if (done.length) ledger.add({ t: 'reported', at: new Date().toISOString(), slugs: done.map(t => t.slug) });
    if (done.length < due.length) say(`  Flagsmith has not confirmed ${due.length - done.length} outcomes yet; they are sent again`);
  };

  const settleDue = async () => {
    const now = clock();
    const due = ledger.pending().filter(t => t.end + RESOLVE_AFTER <= now);
    await Promise.all(due.map(async t => {
      let winner;
      try { winner = await resolution(t.condition); } catch { return; }
      const at = new Date().toISOString();
      if (!winner) {
        if (now - t.end > GIVE_UP_AFTER) ledger.add({ t: 'void', at, slug: t.slug, why: 'Polymarket had not resolved the market after six hours' });
        return;
      }
      const won = winner === t.side;
      const { payout, profit } = settle(t, won);
      ledger.add({ t: 'settle', at, slug: t.slug, winner, won, payout, profit });
      say(`${hhmm(now)}  ${t.asset.padEnd(4)} ${t.arm.padEnd(8)} said ${t.side.padEnd(4)} at ${t.price.toFixed(2)}, resolved ${winner.padEnd(4)}  ${won ? 'won ' : 'lost'} ${profit >= 0 ? '+' : ''}${profit.toFixed(2)}`);
    }));
    trip();
    await report();
    if (due.length) await publish();
  };

  const openWindow = async (start: number) => {
    const prices = new Map<Asset, Candle[]>();
    await Promise.all([...new Set<Asset>([...o.venue.assets, 'btc'])].map(async a => {
      try { prices.set(a, await candles(a, LOOKBACK_MINUTES + 8)); } catch { /* the asset sits this window out */ }
    }));
    const at = () => new Date().toISOString();
    let opened = 0, off = false;
    await Promise.all(o.venue.assets.map(async asset => {
      const slug = slugOf(asset, start);
      if (ledger.trades.has(slug)) return;
      const skip = (why: string) => { ledger.add({ t: 'skip', at: at(), slug, why }); };
      const m = await market(asset, start);
      if (!m) return skip('no market');
      const own = prices.get(asset), btc = prices.get('btc');
      const signals = own && btc ? signalsAt(own, btc, start) : null;
      if (!signals) return skip('no prices');
      let book;
      try { book = await Promise.all([asks(m.tokens.up), asks(m.tokens.down)]); } catch { return skip('no order book'); }
      const fills = { up: fill(book[0], o.venue.stake, m.fee, m.minShares), down: fill(book[1], o.venue.stake, m.fee, m.minShares) };
      if (!fills.up || !fills.down) return skip('book too thin for the stake');
      if (fills.up.price > o.venue.max_price || fills.down.price > o.venue.max_price) return skip(`not an even bet: up ${fills.up.price}, down ${fills.down.price}`);
      if (clock() > start + LATE) return skip('too late');
      // From here on the market belongs to a version.
      let seat;
      try { seat = await o.desk.seat(slug); } catch { return skip('Flagsmith did not answer'); }
      if (!seat.enabled) { off = true; return; }
      const trader = parseTrader(seat.value);
      if (!trader) { say(`  ${slug}: ${seat.arm} is not a trader the runner can read, so it placed nothing`); return; }
      const call = decide(trader, signals, asset, slug);
      const f = fills[call.side]!;
      const phase: Phase = o.dry ? 'dry' : seat.enrolled ? 'experiment' : 'after';
      ledger.add({ t: 'open', at: at(), slug, asset, start, end: m.end, condition: m.condition, arm: seat.arm, phase, side: call.side, rule: call.rule, signals, price: f.price, top: f.top, shares: f.shares, cost: f.cost, fee: f.fee });
      if (phase === 'experiment') { sent.set(`seat|${slug}`, clock()); send(o.events.placed, slug); }
      opened++;
      say(`${hhmm(clock())}  ${asset.padEnd(4)} ${seat.arm.padEnd(8)} says ${call.side.padEnd(4)} at ${f.price.toFixed(2)}${call.rule ? `  (rule ${call.rule})` : ''}`);
    }));
    await o.desk.flush();
    note = off ? `The flag is off, so nothing trades (${hhmm(start)} UTC).` : '';
    if (off && !opened) say(`${hhmm(clock())}  the flag is off: no trades for the ${hhmm(start)} markets`);
    if (opened) say(`       so far ${o.order.map(arm => `${arm} ${have(arm)}`).join(', ')}${o.target ? `; each needs ${o.target}` : ''}`);
    await publish();
  };

  const have = (arm: string) => [...ledger.trades.values()].filter(t => t.arm === arm && t.phase !== 'after').length;
  const full = () => o.target !== undefined && !o.decided?.() && o.order.every(arm => have(arm) >= o.target!);
  /** Holds the runner while the experiment has its sample and nobody has read the result. */
  const hold = async () => {
    let said = 0;
    while (!stopped() && full()) {
      const left = ledger.pending().length + ledger.unreported().length;
      if (said === 0 || (said === 1 && !left)) {
        note = left
          ? `Every version has its ${o.target} markets. The last ${left} are being settled; nothing new is traded.`
          : `Every version has its ${o.target} markets and Flagsmith has every outcome. Nothing is traded until the result is read.`;
        say(`${hhmm(clock())}  ${note}${left ? '' : ' In two minutes: npm run arena -- verdict'}`);
        said = left ? 1 : 2;
        await publish();
      }
      await settleDue().catch(trouble);
      await beat();
      await sleep(10_000, o.signal);
    }
  };

  /** Holds the runner while the loss limit has stopped the arena. Open trades are still settled and reported. */
  const halt = async () => {
    let said = false;
    while (!stopped() && ledger.halted) {
      const h = ledger.halted;
      const by = o.restarted?.(h.at);
      if (by) {
        ledger.add({ t: 'resume', at: new Date().toISOString(), halted_at: h.at, by });
        note = '';
        say(`${hhmm(clock())}  Restarted by ${by}. Every version trades again and losses are counted from here.`);
        await publish();
        return;
      }
      if (!said) {
        note = `The loss limit stopped every version at ${h.at.slice(11, 16)} UTC: ${h.lost.toFixed(2)} paper dollars lost within ${h.over} settled markets, and the limit is ${h.max_loss}. Nothing is traded until a person restarts the arena.`;
        say(`${hhmm(clock())}  ${note} In your own terminal: npm run arena -- resume`);
        said = true;
        await publish();
      }
      await settleDue().catch(trouble);
      await beat();
      await sleep(10_000, o.signal);
    }
  };

  // The runner trades for hours. One window that goes wrong is said and left behind, not fatal.
  const trouble = (e: unknown) => say(`  ${hhmm(clock())}  ${e instanceof Error ? e.message : String(e)}; carrying on`);

  trip();
  await report();
  await publish();
  for (let done = 0; !stopped() && (o.windows === undefined || done < o.windows);) {
    await hold();
    await halt();
    if (stopped()) break;
    const start = Math.ceil((clock() + LEAD) / WINDOW) * WINDOW;
    // Polymarket lists these markets a day ahead, so the lookups never wait for the last moment.
    await Promise.all(o.venue.assets.flatMap(a => [market(a, start), market(a, start + WINDOW)]));
    while (!stopped() && !ledger.halted && clock() < start - LEAD) {
      // Settling waits on Polymarket; it never starts so late that it could hold up the next decision.
      if (start - LEAD - clock() > 12) { await settleDue().catch(trouble); await beat(); }
      await sleep(Math.min(10_000, Math.max(0, (start - LEAD - clock()) * 1000)), o.signal);
    }
    if (stopped()) break;
    if (ledger.halted) continue; // the limit was reached while waiting: back to the top, where the runner holds
    await openWindow(start).catch(trouble);
    done++;
    for (const k of markets.keys()) if (Number(k.slice(k.lastIndexOf('-') + 1)) < start - WINDOW) markets.delete(k);
  }
  // Rehearsals wait for their last trades to resolve; a stopped runner settles the rest when it next starts.
  while (!stopped() && o.windows !== undefined && ledger.pending().length) { await settleDue(); await sleep(5000, o.signal); }
  await report();
  await publish();
  await o.desk.close().catch(() => {});
}
