import { hitValues, norm, renameKind, replaceLiteral } from '../scanner.ts';
import { closest, hasLiteral, trimEvidence, type RawFinding, type Rule } from './context.ts';

/** EG001: a running metric's event name disappears from a call site. */
export const eg001: Rule = ctx => {
  const out: RawFinding[] = [];
  for (const exp of ctx.running) {
    for (const event of exp.metricEvents) {
      const removed = ctx.removed.filter(l => hasLiteral(l, event));
      if (removed.length === 0) continue;
      // Restored or moved anywhere in the PR: not a loss.
      if (ctx.added.some(l => hasLiteral(l, event))) continue;
      const stillSent = ctx.headLines(event).some(l => l.literals.has(event));
      const seen = new Set<string>();
      for (const r of removed) {
        const key = `${r.file}:${r.line}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Look for what replaced it in the same file: a near-identical literal.
        const candidates = ctx.added
          .filter(a => a.file === r.file)
          .flatMap(a => [...a.literals].map(v => ({ a, v, kind: renameKind(event, v) })))
          .filter(c => c.kind !== null)
          .map(c => ({ ...c, line: c.a.line }));
        const cand = closest(candidates, r.line);
        const consequence = stillSent
          ? `This call site stops sending '${event}'. Other code still sends it, so only users who reach this path stop counting. If this path belongs to one arm, that arm will look like it is losing.`
          : `Nothing in the codebase sends '${event}' any more. Every conversion for "${exp.name}" stops counting and its results freeze.`;
        const finding: RawFinding = {
          rule: 'EG001',
          experiment: exp,
          file: r.file,
          line: cand ? cand.a.line : r.line,
          side: cand ? 'added' : 'removed',
          evidence: cand ? `- ${trimEvidence(r.text)}\n+ ${trimEvidence(cand.a.text)}` : `- ${trimEvidence(r.text)}`,
          consequence,
        };
        if (cand) {
          finding.hint = cand.kind === 'style'
            ? `Renamed to '${cand.v}'. Flagsmith matches event names exactly, so '${cand.v}' counts toward nothing.`
            : `Possible typo: '${cand.v}' is not the metric's event '${event}'.`;
          finding.suggestion = {
            file: cand.a.file,
            line: cand.a.line,
            original: cand.a.text,
            replacement: replaceLiteral(cand.a.text, cand.v, event),
          };
        }
        out.push(finding);
      }
    }
  }
  return out;
};

/** EG009: an added event name matches a running metric only when case and separators are ignored. */
export const eg009: Rule = ctx => {
  const out: RawFinding[] = [];
  const events = new Map<string, { event: string; exp: (typeof ctx.running)[number] }>();
  for (const exp of ctx.running) for (const e of exp.metricEvents) events.set(norm(e), { event: e, exp });
  const exact = new Set(ctx.running.flatMap(e => e.metricEvents));
  for (const a of ctx.added) {
    for (const v of hitValues(a, 'conversion')) {
      if (exact.has(v)) continue;
      const match = events.get(norm(v));
      if (!match) continue;
      out.push({
        rule: 'EG009',
        experiment: match.exp,
        file: a.file,
        line: a.line,
        side: 'added',
        evidence: `+ ${trimEvidence(a.text)}`,
        consequence: `'${v}' is not '${match.event}', so these events will not count toward the metric.`,
        suggestion: { file: a.file, line: a.line, original: a.text, replacement: replaceLiteral(a.text, v, match.event) },
      });
    }
  }
  return out;
};
