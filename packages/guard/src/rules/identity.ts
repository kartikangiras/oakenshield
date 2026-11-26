import { hasHit } from '../scanner.ts';
import type { ScannedLine } from '../types.ts';
import { trimEvidence, type RawFinding, type Rule } from './context.ts';

/** EG007: identity logic changes while experiments run. */
export const eg007: Rule = ctx => {
  if (ctx.running.length === 0) return [];
  const out: RawFinding[] = [];
  const extra = ctx.config.identityPatterns;
  // Changing existing identity code is risky; brand-new calls that pass an identifier are not.
  const touches = (l: ScannedLine) =>
    extra.some(p => l.text.includes(p)) || (l.side === 'removed' && hasHit(l, 'identity'));
  const seen = new Set<string>();
  for (const l of [...ctx.removed, ...ctx.added]) {
    if (!touches(l) || seen.has(l.file)) continue;
    seen.add(l.file);
    out.push({
      rule: 'EG007',
      experiment: ctx.running.length === 1 ? ctx.running[0] : null,
      file: l.file,
      line: l.line,
      side: l.side,
      evidence: `${l.side === 'removed' ? '-' : '+'} ${trimEvidence(l.text)}`,
      consequence: 'This touches how users are identified. If the identifier changes for a returning user, their exposure and conversions stop matching, and anyone seen in two arms is quarantined.',
    });
  }
  return out;
};

/** EG011: experiment calls with dynamic keys cannot be verified. */
export const eg011: Rule = ctx => {
  const out: RawFinding[] = [];
  for (const a of ctx.added) {
    const dyn = a.hits.find(h => h.kind === 'dynamic');
    if (!dyn) continue;
    out.push({
      rule: 'EG011',
      experiment: null,
      file: a.file,
      line: a.line,
      side: 'added',
      evidence: `+ ${trimEvidence(a.text)}`,
      consequence: `${dyn.value}() is called with a computed name, so Guard cannot tell which experiment or metric it belongs to.`,
    });
  }
  return out;
};
