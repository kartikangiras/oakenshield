import { hasHit, hitValues, renameKind, replaceLiteral, scanText, langOf } from '../scanner.ts';
import type { LiveExperiment } from '../types.ts';
import { closest, hasLiteral, trimEvidence, type RawFinding, type Rule } from './context.ts';

function keyIndex(running: LiveExperiment[]): Map<string, LiveExperiment> {
  const m = new Map<string, LiveExperiment>();
  for (const exp of running) for (const k of exp.variationKeys) if (k !== 'control') m.set(k, exp);
  return m;
}

/** EG005: comparisons against variation keys are removed, changed, or point at keys that do not exist. */
export const eg005: Rule = ctx => {
  const out: RawFinding[] = [];
  const keys = keyIndex(ctx.running);
  const used = new Set<string>();

  for (const r of ctx.removed) {
    for (const v of hitValues(r, 'variant')) {
      const exp = keys.get(v);
      if (!exp) continue;
      if (ctx.added.some(a => hasLiteral(a, v))) continue; // the key survives somewhere in the PR
      const candidates = ctx.added
        .filter(a => a.file === r.file)
        .flatMap(a => hitValues(a, 'variant').map(w => ({ a, w, line: a.line, kind: renameKind(v, w) })))
        .filter(c => !keys.has(c.w));
      const cand = closest(candidates.filter(c => c.kind !== null), r.line) ?? closest(candidates, r.line);
      if (cand) used.add(`${cand.a.file}:${cand.a.line}`);
      out.push({
        rule: 'EG005',
        experiment: exp,
        file: r.file,
        line: cand ? cand.a.line : r.line,
        side: cand ? 'added' : 'removed',
        evidence: cand ? `- ${trimEvidence(r.text)}\n+ ${trimEvidence(cand.a.text)}` : `- ${trimEvidence(r.text)}`,
        consequence: cand
          ? `The flag still serves '${v}', but this code now checks for '${cand.w}'. Users bucketed into '${v}' see control code while being counted in '${v}'.`
          : `Code that branched on '${v}' is gone. Users bucketed into '${v}' are still counted there but no longer see the variation.`,
        suggestion: cand ? { file: cand.a.file, line: cand.a.line, original: cand.a.text, replacement: replaceLiteral(cand.a.text, cand.w, v) } : undefined,
      });
    }
  }

  for (const a of ctx.added) {
    if (used.has(`${a.file}:${a.line}`)) continue;
    // Only explicit `.variant === 'x'` style comparisons, not every `case 'x':`.
    if (!/\.variant\b/.test(a.text)) continue;
    for (const w of hitValues(a, 'variant')) {
      if (keys.has(w) || w === 'control') continue;
      const near = [...keys.keys()].find(k => renameKind(k, w) !== null);
      if (!near) continue;
      const exp = keys.get(near)!;
      out.push({
        rule: 'EG005',
        experiment: exp,
        file: a.file,
        line: a.line,
        side: 'added',
        evidence: `+ ${trimEvidence(a.text)}`,
        consequence: `'${w}' is not a variation of '${exp.flagKey}'. The flag serves '${near}', so this branch never runs while users are still counted in '${near}'.`,
        suggestion: { file: a.file, line: a.line, original: a.text, replacement: replaceLiteral(a.text, w, near) },
      });
    }
  }
  return out;
};

const REGION = 40;

/**
 * Where the branch that starts on line `start` (0-based) ends: the line where its
 * braces close, a few lines for ternaries and one-liners, at most REGION lines.
 */
export function regionEnd(lines: string[], start: number, lang: string): number {
  const cap = Math.min(lines.length - 1, start + (lang === 'py' ? 15 : REGION));
  if (lang !== 'js') return cap;
  let depth = 0;
  let opened = false;
  for (let i = start; i <= cap; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--;
    }
    if (opened && depth <= 0) return i;
    if (i === start && !opened) return Math.min(cap, start + 6);
  }
  return cap;
}

interface Branch {
  file: string;
  start: number;
  end: number;
  key: string;
  exp: LiveExperiment;
  components: Set<string>;
}

function basename(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.[^.]+$/, '');
}

/** EG006: code inside one arm changes while the experiment runs. */
export const eg006: Rule = ctx => {
  const out: RawFinding[] = [];
  const keys = keyIndex(ctx.running);
  if (keys.size === 0) return out;

  // Find branch regions on the head revision: lines comparing against a running key.
  const branches: Branch[] = [];
  for (const [key, exp] of keys) {
    for (const hit of ctx.headLines(key)) {
      if (!hasHit(hit, 'variant', key)) continue;
      const content = ctx.headFile(hit.file);
      const lines = content ? content.split('\n') : [hit.text];
      const startIdx = content ? hit.line - 1 : 0;
      const endIdx = regionEnd(lines, startIdx, langOf(hit.file));
      const regionText = lines.slice(startIdx, endIdx + 1).join('\n');
      const components = new Set<string>();
      if (langOf(hit.file) === 'js') {
        for (const m of regionText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) components.add(m[1]);
      }
      branches.push({ file: hit.file, start: hit.line, end: hit.line + (endIdx - startIdx), key, exp, components });
    }
  }
  if (branches.length === 0) return out;

  const reported = new Set<string>();
  const changedFiles = new Set([...ctx.added, ...ctx.removed].map(l => l.file));
  for (const file of changedFiles) {
    const addedHere = ctx.added.filter(l => l.file === file && l.text.trim() !== '');
    // 1) Lines changed inside a branch region in the same file.
    for (const b of branches.filter(br => br.file === file)) {
      const inside = addedHere.find(l => l.line > b.start && l.line <= b.end && !hasHit(l, 'variant'));
      const tag = `${b.exp.id}:${file}`;
      if (!inside || reported.has(tag)) continue;
      reported.add(tag);
      out.push({
        rule: 'EG006',
        experiment: b.exp,
        file,
        line: inside.line,
        side: 'added',
        evidence: `+ ${trimEvidence(inside.text)}`,
        consequence: `This change sits inside the '${b.key}' branch of "${b.exp.name}". Results will mix users who saw the old and new '${b.key}', so the interval describes neither.`,
      });
    }
    // 2) A component rendered only from a branch region.
    const name = basename(file);
    for (const b of branches) {
      if (b.file === file || !b.components.has(name)) continue;
      const tag = `${b.exp.id}:${file}`;
      if (reported.has(tag)) continue;
      const first = addedHere[0] ?? ctx.removed.find(l => l.file === file);
      if (!first) continue;
      reported.add(tag);
      out.push({
        rule: 'EG006',
        experiment: b.exp,
        file,
        line: first.line,
        side: first.side,
        evidence: `${first.side === 'removed' ? '-' : '+'} ${trimEvidence(first.text)}`,
        consequence: `<${name}> is rendered from the '${b.key}' branch of "${b.exp.name}" (${b.file}:${b.start}). Changing it mid-run mixes two versions of that arm.`,
      });
    }
  }
  return out;
};

/** Lightweight scan helper reused by tests. */
export function variantKeysIn(text: string, path: string): string[] {
  return scanText(text, langOf(path)).hits.filter(h => h.kind === 'variant').map(h => h.value);
}
