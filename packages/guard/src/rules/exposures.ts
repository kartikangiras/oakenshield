import { exposureCalls, hasHit, isConfigFile } from '../scanner.ts';
import type { LiveExperiment } from '../types.ts';
import { trimEvidence, type RawFinding, type Rule, type RuleContext } from './context.ts';

/**
 * The flag key is kept in a config file and the code passes it to the SDK through a variable
 * (getExperimentFlag(plan.flag)). No call names the flag, so the line that declares the key stands
 * in for the read: losing that line, or the last call that reads a flag this way, ends the experiment's intake.
 */
function declaredFlag(ctx: RuleContext, exp: LiveExperiment): RawFinding[] {
  const key = exp.flagKey;
  const base = ctx.baseLines(key);
  if (base.some(l => hasHit(l, 'exposure', key))) return []; // the code names the flag itself, so config is not what it reads
  const calls = exposureCalls(ctx.config.calls);
  const through = (lines: RuleContext['headLines'], fn: string) => lines(fn).some(l => hasHit(l, 'dynamic', fn));
  const out: RawFinding[] = [];

  // A pasted diff has no base tree to check, so a declaration that goes counts there.
  const pasted = ctx.repo.kind === 'diff-only';
  const gone = ctx.removed.filter(l => isConfigFile(l.file) && l.literals.has(key));
  if (gone.length > 0 && !ctx.added.some(l => l.literals.has(key)) && (pasted || calls.some(fn => through(ctx.baseLines, fn)))) {
    const named = ctx.headLines(key).find(l => l.literals.has(key));
    for (const r of gone) {
      out.push({
        rule: 'EG002',
        experiment: exp,
        file: r.file,
        line: r.line,
        side: 'removed',
        evidence: `- ${trimEvidence(r.text)}`,
        consequence: named
          ? `This file no longer declares '${key}', and the code reads its experiment flag through a variable. If that variable is filled from here, the code now asks Flagsmith for another flag and no new users enter "${exp.name}". ${named.file}:${named.line} still names '${key}'.`
          : `Nothing declares '${key}' any more, and the code reads its experiment flag through a variable. It now asks Flagsmith for another flag, or none. No new users enter "${exp.name}", so its results stop growing.`,
      });
    }
  }

  const at = pasted ? undefined : base.find(l => isConfigFile(l.file) && l.literals.has(key));
  if (!at) return out;
  for (const fn of calls) {
    const lost = ctx.removed.filter(l => hasHit(l, 'dynamic', fn));
    if (lost.length === 0 || ctx.added.some(l => hasHit(l, 'dynamic', fn))) continue; // moved or rewritten
    if (through(ctx.headLines, fn)) continue; // another call still reads a flag this way, and Guard cannot tell which flag
    for (const r of lost) {
      out.push({
        rule: 'EG002',
        experiment: exp,
        file: r.file,
        line: r.line,
        side: 'removed',
        evidence: `- ${trimEvidence(r.text)}`,
        consequence: `No ${fn} call takes its flag key from a variable any more. '${key}' is declared in ${at.file}:${at.line} and no code reads it by name, so this call was how "${exp.name}" got its users. No new users enter it and its results stop growing.`,
      });
    }
  }
  return out;
}

/** EG002: a running experiment's flag is no longer evaluated where it was. */
export const eg002: Rule = ctx => {
  const out: RawFinding[] = [];
  for (const exp of ctx.running) {
    const key = exp.flagKey;
    const removed = ctx.removed.filter(l => hasHit(l, 'exposure', key));
    if (removed.length === 0) {
      out.push(...declaredFlag(ctx, exp));
      continue;
    }
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
