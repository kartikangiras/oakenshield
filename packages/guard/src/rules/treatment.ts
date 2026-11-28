import { matchesAny } from '../glob.ts';
import { hasHit, hitValues, renameKind, replaceLiteral, scanText, langOf } from '../scanner.ts';
import type { LiveExperiment } from '../types.ts';
import { closest, firstWiredHere, hasLiteral, trimEvidence, type RawFinding, type Rule, type RuleContext } from './context.ts';

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

const net = (text: string) => {
  let depth = 0;
  for (const ch of text) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
  }
  return depth;
};
const indentOf = (text: string) => text.length - text.trimStart().length;
const isComment = (text: string) => /^\s*(?:\/\/|\/?\*|#)/.test(text);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `?` as a ternary: not `?.`, `??` or the `?:` of an optional parameter.
const JS_TERNARY = /(?<!\?)\?(?![.?:])/;
const JS_GUARD = /\bif\s*\(.*\)\s*(?:return|throw|continue|break)\b/;
const JS_CASE = /\bcase\s+['"`][^'"`\n]+['"`]\s*:/;

/** Does the line choose between code paths, rather than compute or store a value? */
export function branchesOn(text: string, lang: string): boolean {
  if (lang === 'py') return /^\s*(?:if|elif|while)\b/.test(text) || /\sif\s.+\selse\s/.test(text) || /\s(?:and|or)\s/.test(text);
  return /\b(?:if|while)\s*\(/.test(text) || JS_CASE.test(text) || /&&|\|\|/.test(text) || JS_TERNARY.test(text);
}

/**
 * Where the branch that starts on line `start` (0-based) ends: where its brackets close,
 * where the next `case` begins, the rest of the block after a guard clause, or the
 * indented block in Python. At most REGION lines.
 */
export function regionEnd(lines: string[], start: number, lang: string): number {
  const cap = Math.min(lines.length - 1, start + REGION);
  const first = lines[start];

  if (lang === 'py') {
    if (!/:\s*(?:#.*)?$/.test(first)) return start; // an inline conditional, or a body on the same line
    const indent = indentOf(first);
    let end = start;
    for (let i = start + 1; i <= cap; i++) {
      if (lines[i].trim() === '') continue;
      const deeper = indentOf(lines[i]) > indent;
      if (!deeper && !(indentOf(lines[i]) === indent && /^\s*(?:elif\b|else\s*:)/.test(lines[i]))) break;
      end = i;
    }
    return end;
  }
  if (lang !== 'js') return cap;

  if (JS_CASE.test(first) && !/\bif\s*\(/.test(first)) {
    let depth = 0;
    for (let i = start + 1; i <= cap; i++) {
      if (depth === 0 && /^\s*(?:case\b|default\s*:)/.test(lines[i])) return i - 1;
      depth += net(lines[i]);
      if (depth < 0) return i - 1;
      if (depth === 0 && /^\s*break\s*;?\s*$/.test(lines[i])) return i;
    }
    return cap;
  }

  // `} else if (…) {` closes the previous block before it opens its own.
  let depth = net(first.replace(/^\s*[}\])]+/, ''));
  if (depth > 0) {
    for (let i = start + 1; i <= cap; i++) {
      depth += net(lines[i]);
      if (depth <= 0) return i;
    }
    return cap;
  }
  if (JS_GUARD.test(first)) {
    // A guard clause: the rest of the enclosing block runs for one arm only.
    depth = 0;
    for (let i = start + 1; i <= cap; i++) {
      depth += net(lines[i]);
      if (depth < 0) return i - 1;
    }
    return cap;
  }
  if (/[;,})\]]\s*(?:\/\/.*)?$/.test(first)) return start; // complete on its own line
  // The statement runs on: a braceless if, or a ternary wrapped over the next lines.
  const soft = Math.min(cap, start + 6);
  depth = 0;
  for (let i = start + 1; i <= soft; i++) {
    depth += net(lines[i]);
    if (depth < 0) return i - 1;
    if (depth === 0 && /;\s*(?:\/\/.*)?$/.test(lines[i])) return i;
  }
  return soft;
}

/**
 * The name a variant comparison is stored under, when the line only stores it:
 * `const showUsd = flag.variant === 'show_usd';`. The branch is then wherever that name is tested.
 */
export function aliasOf(lines: string[], idx: number, lang: string): string | null {
  const text = lines[idx];
  const next = lines.slice(idx + 1).find(l => l.trim() !== '') ?? '';
  if (lang === 'py') {
    if (/\sif\s.+\selse\s/.test(text)) return null;
    return text.match(/^\s*([A-Za-z_]\w*)\s*(?::\s*[\w[\], .]+)?=(?!=)/)?.[1] ?? null;
  }
  if (lang !== 'js') return null;
  if (JS_TERNARY.test(text) || /^\s*\?(?![.?:])/.test(next) || /=>/.test(text)) return null;
  const decl = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=(?!=)/;
  const own = text.match(decl)?.[1];
  if (own) return own;
  // Formatters wrap a long assignment: the name sits on the line above.
  const prev = idx > 0 ? lines[idx - 1] : '';
  return /=\s*$/.test(prev) ? prev.match(decl)?.[1] ?? null : null;
}

/** Lines (0-based) after `idx`, in the same scope, that branch on `name`. */
export function aliasUses(lines: string[], idx: number, name: string, lang: string): number[] {
  const n = `(?<![\\w$.])${escapeRe(name)}(?![\\w$])`;
  const tested = lang === 'py'
    ? new RegExp(`^\\s*(?:if|elif|while)\\b.*${n}|\\sif\\s+(?:not\\s+)?${n}.*\\selse\\s|${n}\\s+(?:and|or)\\s|\\s(?:and|or)\\s+(?:not\\s+)?${n}`)
    : new RegExp(`\\b(?:if|while)\\s*\\(.*${n}|${n}\\s*(?:&&|\\|\\||\\?(?![.?:]))|(?:&&|\\|\\|)\\s*!?\\s*${n}`);
  const out: number[] = [];
  const indent = indentOf(lines[idx]);
  let depth = 0;
  for (let i = idx + 1; i < lines.length; i++) {
    const text = lines[i];
    if (lang === 'py') {
      if (text.trim() !== '' && indentOf(text) < indent) break;
    } else {
      depth += net(text);
      if (depth < 0) break; // the block that declared the name has closed
    }
    if (!isComment(text) && tested.test(text)) out.push(i);
  }
  return out;
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

/**
 * Files the project lists under `treatment_paths` for a running flag. When the flag's value is data
 * (a JSON document, a rule set) the code that gives it meaning has no branch on a variation key,
 * so Guard cannot find it by reading: the project says where it is.
 */
function listedTreatment(ctx: RuleContext): RawFinding[] {
  const out: RawFinding[] = [];
  for (const exp of ctx.running) {
    const globs = ctx.config.treatmentPaths[exp.flagKey] ?? [];
    if (globs.length === 0 || firstWiredHere(ctx, exp)) continue;
    for (const f of ctx.files) {
      if (!matchesAny(f.path, globs)) continue;
      const first = ctx.added.find(l => l.file === f.path && l.text.trim() !== '') ?? ctx.removed.find(l => l.file === f.path);
      if (!first) continue;
      out.push({
        rule: 'EG006',
        experiment: exp,
        file: f.path,
        line: first.line,
        side: first.side,
        evidence: `${first.side === 'added' ? '+' : '-'} ${trimEvidence(first.text)}`,
        consequence: `${f.path} is listed under treatment_paths for '${exp.flagKey}': it decides what the flag's value does. Results for "${exp.name}" will mix users served by the old and the new code, so the interval describes neither.`,
      });
    }
  }
  return out;
}

/** EG006: code inside one arm changes while the experiment runs. */
export const eg006: Rule = ctx => {
  const out: RawFinding[] = listedTreatment(ctx);
  const keys = keyIndex(ctx.running);
  if (keys.size === 0) return out;

  // Find branch regions on the head revision: code that only runs for one variation of a running experiment.
  const branches: Branch[] = [];
  const firstWired = new Map<LiveExperiment, boolean>();
  for (const [key, exp] of keys) {
    // A pull request that wires the experiment up for the first time has no earlier arm to change.
    if (!firstWired.has(exp)) firstWired.set(exp, firstWiredHere(ctx, exp));
    if (firstWired.get(exp)) continue;
    for (const hit of ctx.headLines(key)) {
      if (!hasHit(hit, 'variant', key)) continue;
      const lang = langOf(hit.file);
      const content = ctx.headFile(hit.file);
      const lines = content ? content.split('\n') : [hit.text];
      const hitIdx = content ? hit.line - 1 : 0;
      const alias = aliasOf(lines, hitIdx, lang);
      const starts = alias ? aliasUses(lines, hitIdx, alias, lang) : branchesOn(lines[hitIdx], lang) ? [hitIdx] : [];
      for (const startIdx of starts) {
        const endIdx = regionEnd(lines, startIdx, lang);
        const regionText = lines.slice(startIdx, endIdx + 1).join('\n');
        const components = new Set<string>();
        if (lang === 'js') {
          for (const m of regionText.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)) components.add(m[1]);
        }
        const first = hit.line + (startIdx - hitIdx);
        branches.push({ file: hit.file, start: first, end: first + (endIdx - startIdx), key, exp, components });
      }
    }
  }
  if (branches.length === 0) return out;

  const reported = new Set<string>();
  const changedFiles = new Set([...ctx.added, ...ctx.removed].map(l => l.file));
  for (const file of changedFiles) {
    const addedHere = ctx.added.filter(l => l.file === file && l.text.trim() !== '');
    // 1) Lines changed inside a branch region in the same file. Edits to the comparison itself belong to EG005.
    for (const b of branches.filter(br => br.file === file)) {
      const inside = addedHere.find(l => l.line >= b.start && l.line <= b.end && !hasHit(l, 'variant'));
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
