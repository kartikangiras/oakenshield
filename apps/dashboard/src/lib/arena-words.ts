/*
 * The arena's files in plain words, for the two pages that show them: the dashboard's Arena page
 * and the landing page. Types only from packages/arena, so nothing of the runner is bundled.
 */
import type { Condition, Rule } from '../../../../packages/arena/src/playbook.ts';

const SIGNAL: Record<string, [label: string, unit: string]> = {
  ret_1m: ['the 1 minute change', '%'],
  ret_5m: ['the 5 minute change', '%'],
  ret_15m: ['the 15 minute change', '%'],
  ret_60m: ['the 60 minute change', '%'],
  btc_ret_5m: ["Bitcoin's 5 minute change", '%'],
  btc_ret_15m: ["Bitcoin's 15 minute change", '%'],
  streak: ['the run of five minute steps in one direction', ''],
  range_15m: ['the 15 minute range', '%'],
  volume_ratio: ["volume against the hour's average", '×'],
  hour_utc: ['the hour (UTC)', ''],
};
const OP: Record<Condition['op'], string> = { '>': 'above', '>=': 'at least', '<': 'under', '<=': 'at most' };
const amount = (v: number, unit: string) => `${v < 0 ? '−' : ''}${Math.abs(v)}${unit}`;

/** A rule's conditions as a sentence. Two bounds on one signal read as a range. */
export function inWords(rule: Rule): string {
  const bySignal = new Map<string, Condition[]>();
  for (const c of rule.when) bySignal.set(c.signal, [...(bySignal.get(c.signal) ?? []), c]);
  const said = [...bySignal].map(([signal, cs]) => {
    const [label, unit] = SIGNAL[signal] ?? [signal, ''];
    const low = cs.find(c => c.op === '>' || c.op === '>=');
    const high = cs.find(c => c.op === '<' || c.op === '<=');
    if (cs.length === 2 && low && high) return `${label} is from ${amount(low.value, unit)} to ${amount(high.value, unit)}`;
    return cs.map(c => `${label} is ${OP[c.op]} ${amount(c.value, unit)}`).join(' and ');
  });
  const only = rule.assets?.length ? `For ${rule.assets.map(a => a.toUpperCase()).join(', ')}: when ` : 'When ';
  return `${only}${said.join(', and ')}`;
}

/** The skill writes its reasons with the versions' keys; the page uses their names. */
export const named = (text: string) => text.replace(/\bagent_a\b/g, 'Agent A').replace(/\bagent_b\b/g, 'Agent B')
  .replace(/\bControl\b/g, 'The coin').replace(/\b(the )?control( version)?\b/g, 'the coin')
  .replace(/\b100\.0% chance/g, 'above 99.9% chance').replace(/\bchi-square\b/g, 'chi square');

/**
 * The share of calls a version needs right to lose nothing, at the prices and fees it paid:
 * a right call pays one dollar a share. Null until a market has settled, and for a state written
 * before the runner counted shares.
 */
export const breakEven = (t: { staked: number; fees: number; shares?: number }) => (t.shares ? (t.staked + t.fees) / t.shares : null);

/** The runner publishes at least once a minute. After three minutes without a word the page says so. */
const QUIET_AFTER = 3 * 60_000;
export interface Heartbeat { at: string; live: boolean; minutes: number }
/** `heardAt` is when the server last got a push; before any push it falls back to the state's own time. */
export function heartbeat(heardAt: string | null | undefined, updatedAt: string | undefined, now = Date.now()): Heartbeat | null {
  const at = heardAt ?? updatedAt;
  if (!at) return null;
  const quiet = now - Date.parse(at);
  return { at, live: quiet <= QUIET_AFTER, minutes: Math.max(0, Math.floor(quiet / 60_000)) };
}
