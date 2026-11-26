import { hasHit } from '../scanner.ts';
import { trimEvidence, type RawFinding, type Rule } from './context.ts';

/** EG002: a running experiment's flag is no longer evaluated where it was. */
export const eg002: Rule = ctx => {
  const out: RawFinding[] = [];
  for (const exp of ctx.running) {
    const key = exp.flagKey;
    const removed = ctx.removed.filter(l => hasHit(l, 'exposure', key));
    if (removed.length === 0) continue;
    if (ctx.added.some(l => hasHit(l, 'exposure', key))) continue; // moved or rewritten: EG008's job
    const elsewhere = ctx.headLines(key).some(l => hasHit(l, 'exposure', key));
    for (const r of removed) {
      out.push({
        rule: 'EG002',
        experiment: exp,
        file: r.file,
        line: r.line,
        side: 'removed',
        evidence: `- ${trimEvidence(r.text)}`,
        consequence: elsewhere
          ? `This place no longer records exposures for '${key}'. Users who only reach it stop entering "${exp.name}", which skews who gets counted.`
          : `Nothing evaluates '${key}' as an experiment any more. No new users enter "${exp.name}", so its results stop growing.`,
      });
    }
  }
  return out;
};

const ENTRY_POINT = /(^|\/)(layout|_app|_document|app|main|index|root|middleware|providers?|entry[-\w]*)\.[cm]?[jt]sx?$/i;

/** EG008: the exposure call moved somewhere else. */
export const eg008: Rule = ctx => {
  const out: RawFinding[] = [];
  for (const exp of ctx.running) {
    const key = exp.flagKey;
    const removed = ctx.removed.filter(l => hasHit(l, 'exposure', key));
    const added = ctx.added.filter(l => hasHit(l, 'exposure', key));
    if (removed.length === 0 || added.length === 0) continue;
    for (const a of added) {
      const sameSpot = removed.some(r => r.file === a.file && Math.abs(r.line - a.line) <= 20);
      if (sameSpot) continue;
      const from = removed[0];
      const entry = ENTRY_POINT.test(a.file);
      out.push({
        rule: 'EG008',
        experiment: exp,
        file: a.file,
        line: a.line,
        side: 'added',
        evidence: `- ${from.file}:${from.line}  ${trimEvidence(from.text)}\n+ ${a.file}:${a.line}  ${trimEvidence(a.text)}`,
        consequence: entry
          ? `The exposure for '${key}' now fires in ${a.file}, which runs for nearly every visitor. People who never see the change get counted as exposed, diluting the effect.`
          : `The exposure for '${key}' moved from ${from.file} to ${a.file}. Check it still fires exactly where users see the change.`,
      });
    }
  }
  return out;
};
