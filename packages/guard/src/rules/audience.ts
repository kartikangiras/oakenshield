import { renameKind } from '../scanner.ts';
import { extractTraits, type NumberedLine, type TraitAssignment } from '../traits.ts';
import type { FileDiff, LiveExperiment } from '../types.ts';
import { trimEvidence, type RawFinding, type Rule, type RuleContext } from './context.ts';

/* EG012 / EG013: the traits that decide an experiment's audience.
   A segment in Flagsmith matches on trait keys and values. If code stops sending a
   trait, or sends a different value, the experiment's audience changes mid-run. */

const toLines = (s: string | null): NumberedLine[] | null => (s === null ? null : s.split('\n').map((text, i) => ({ line: i + 1, text })));

/** Both versions of a changed file. Falls back to what the hunks show when the repo cannot be read (pasted diffs). */
function versions(ctx: RuleContext, f: FileDiff): { base: NumberedLine[]; head: NumberedLine[] } {
  const base = f.status === 'added' ? [] : toLines(ctx.repo.read('base', f.oldPath ?? f.path));
  const head = f.status === 'deleted' ? [] : toLines(ctx.repo.read('head', f.newPath ?? f.path));
  if (base && head) return { base, head };
  const b: NumberedLine[] = [];
  const h: NumberedLine[] = [];
  for (const hunk of f.hunks) {
    for (const l of hunk.lines) {
      if (l.kind !== 'add' && l.oldLine !== undefined) b.push({ line: l.oldLine, text: l.text });
      if (l.kind !== 'del' && l.newLine !== undefined) h.push({ line: l.newLine, text: l.text });
    }
  }
  return { base: base ?? b, head: head ?? h };
}

/** Another head file that still sends the trait, if any. */
function stillSentElsewhere(ctx: RuleContext, key: string, path: string): string | null {
  const files = new Set(ctx.repo.grep('head', [key]).map(h => h.path).filter(p => p !== path));
  for (const p of files) {
    const lines = toLines(ctx.headFile(p));
    if (lines && extractTraits(lines).some(t => t.key === key)) return p;
  }
  return null;
}

const cache = new WeakMap<RuleContext, RawFinding[]>();

function analyse(ctx: RuleContext): RawFinding[] {
  const hit = cache.get(ctx);
  if (hit) return hit;
  const targets = new Map<string, Array<{ exp: LiveExperiment; segment: string }>>();
  for (const e of ctx.running) {
    for (const s of e.audience ?? []) {
      for (const t of s.traits) {
        const list = targets.get(t) ?? [];
        list.push({ exp: e, segment: s.name });
        targets.set(t, list);
      }
    }
  }
  const out: RawFinding[] = [];
  if (targets.size > 0) {
    for (const f of ctx.files) {
      if (f.binary) continue;
      const removedLines = new Set(ctx.removed.filter(l => l.file === f.path).map(l => l.line));
      const addedLines = new Set(ctx.added.filter(l => l.file === f.path).map(l => l.line));
      if (removedLines.size === 0 && addedLines.size === 0) continue;
      const { base, head } = versions(ctx, f);
      const B = extractTraits(base);
      const H = extractTraits(head);
      for (const [key, who] of targets) {
        const before = B.filter(x => x.key === key);
        if (before.length === 0) continue; // never sent here; sending it for the first time is fine
        const after = H.filter(x => x.key === key);
        const touched = before.some(x => removedLines.has(x.line)) || after.some(x => addedLines.has(x.line));
        if (!touched) continue;
        const { exp, segment } = who[0];
        const audience = `the segment "${segment}" (the audience of "${exp.name}")`;
        if (after.length === 0) {
          const gone: TraitAssignment = before.find(x => removedLines.has(x.line)) ?? before[0];
          const renamed = H.find(x => !B.some(y => y.key === x.key) && addedLines.has(x.line) && renameKind(key, x.key));
          const elsewhere = stillSentElsewhere(ctx, key, f.path);
          out.push({
            rule: elsewhere ? 'EG013' : 'EG012',
            experiment: exp,
            file: f.path,
            line: renamed ? renamed.line : gone.line,
            side: renamed ? 'added' : 'removed',
            evidence: renamed ? `- ${trimEvidence(gone.text)}\n+ ${trimEvidence(renamed.text)}` : `- ${trimEvidence(gone.text)}`,
            consequence: elsewhere
              ? `This code stops sending the '${key}' trait, which ${audience} matches on. ${elsewhere} still sends it, so only users who reach this path change segment.`
              : `Nothing sends the '${key}' trait any more, and ${audience} matches on it. New users stop entering the experiment, and people already in it can drop out of the segment mid-run.`,
            hint: renamed ? `Renamed to '${renamed.key}'. Segment rules match trait keys exactly, so '${renamed.key}' matches nothing.` : undefined,
            suggestion: renamed ? { file: f.path, line: renamed.line, original: renamed.text, replacement: renamed.text.replace(renamed.key, key) } : undefined,
          });
          continue;
        }
        const values = new Set(before.map(x => x.value));
        const changed = after.find(x => addedLines.has(x.line) && !values.has(x.value));
        if (!changed) continue;
        const old = before.find(x => removedLines.has(x.line)) ?? before[0];
        out.push({
          rule: 'EG013',
          experiment: exp,
          file: f.path,
          line: changed.line,
          side: 'added',
          evidence: `- ${trimEvidence(old.text)}\n+ ${trimEvidence(changed.text)}`,
          consequence: `'${key}' decides who matches ${audience}. It was ${old.value} and is now ${changed.value}, so the segment matches a different group of people and the experiment's population shifts mid-run.`,
        });
      }
    }
  }
  cache.set(ctx, out);
  return out;
}

export const eg012: Rule = ctx => analyse(ctx).filter(f => f.rule === 'EG012');
export const eg013: Rule = ctx => analyse(ctx).filter(f => f.rule === 'EG013');
