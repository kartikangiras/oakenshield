import type { CheckSource, ExperimentStatus, RuleId, Verdict } from './api.ts';

const nf = new Intl.NumberFormat('en-US');
const cf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export const num = (n: number) => nf.format(n);
export const compact = (n: number) => (Math.abs(n) >= 10_000 ? cf.format(n) : nf.format(n));
export const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

export function duration(ms: number): string {
  if (ms < 1) return '<1 ms';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.max(1, Math.round(f / 60))}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return `in ${Math.round(f / 86400)}d`;
  }
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return dateShort(iso);
}

export const dateShort = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const dayLabel = (ymd: string) =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function delta(cur: number, prev: number): { pct: number; dir: 'up' | 'down' | 'flat' } {
  if (prev === 0) return { pct: cur > 0 ? 1 : 0, dir: cur > 0 ? 'up' : 'flat' };
  const d = (cur - prev) / prev;
  return { pct: d, dir: Math.abs(d) < 0.005 ? 'flat' : d > 0 ? 'up' : 'down' };
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  pass: 'Passed',
  warn: 'Warning',
  block: 'Blocked',
  overridden: 'Overridden',
};

export const STATUS_LABEL: Record<ExperimentStatus, string> = {
  running: 'Running',
  draft: 'Draft',
  paused: 'Paused',
  ended: 'Ended',
};

export const SOURCE_LABEL: Record<CheckSource, string> = {
  ci: 'GitHub Action',
  cli: 'CLI',
  mcp: 'MCP agent',
  playground: 'Playground',
  api: 'API',
  webhook: 'Flagsmith re-check',
};

export const ruleNum = (id: RuleId) => Number(id.slice(2));

export function plural(n: number, one: string, many = `${one}s`) {
  return `${num(n)} ${n === 1 ? one : many}`;
}
