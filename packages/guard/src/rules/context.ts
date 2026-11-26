import { inScope, type GuardConfig } from '../config.ts';
import type { RepoView, Rev } from '../repo.ts';
import { hasHit, scanLine } from '../scanner.ts';
import type { FileDiff, LiveExperiment, RuleId, ScannedLine, Suggestion } from '../types.ts';

export interface RawFinding {
  rule: RuleId;
  experiment: LiveExperiment | null;
  file: string;
  line: number;
  side: 'added' | 'removed' | 'head';
  evidence: string;
  consequence: string;
  hint?: string;
  suggestion?: Suggestion;
}

export interface RuleContext {
  config: GuardConfig;
  running: LiveExperiment[];
  files: FileDiff[];
  added: ScannedLine[];
  removed: ScannedLine[];
  repo: RepoView;
  /** Head-revision lines in scanned code (scan.include minus scan.exclude) that contain the literal. Cached. */
  headLines(literal: string): ScannedLine[];
  /** The same for the base revision: what the code did before this pull request. Cached. */
  baseLines(literal: string): ScannedLine[];
  /** Whole head-revision file content, or null. Cached. */
  headFile(path: string): string | null;
}

export type Rule = (ctx: RuleContext) => RawFinding[];

export function buildContext(opts: {
  config: GuardConfig;
  running: LiveExperiment[];
  files: FileDiff[];
  added: ScannedLine[];
  removed: ScannedLine[];
  repo: RepoView;
}): RuleContext {
  const grepCache = new Map<string, ScannedLine[]>();
  const fileCache = new Map<string, string | null>();
  const lines = (rev: Rev, literal: string) => {
    const key = `${rev}:${literal}`;
    if (!grepCache.has(key)) {
      // Only code the guard reads: a README or docs page that names the event does not send it.
      const hits = opts.repo.grep(rev, [literal])
        .filter(h => inScope(h.path, opts.config))
        .map(h => scanLine(h.path, h.line, h.text, 'head', opts.config.calls));
      grepCache.set(key, hits);
    }
    return grepCache.get(key)!;
  };
  return {
    ...opts,
    headLines: literal => lines('head', literal),
    baseLines: literal => lines('base', literal),
    headFile(path: string) {
      if (!fileCache.has(path)) fileCache.set(path, opts.repo.read('head', path));
      return fileCache.get(path)!;
    },
  };
}

/**
 * True when this pull request is the first code to evaluate the experiment's flag. Nobody has been
 * exposed through this codebase yet, so nothing it adds can change what an arm already showed.
 * A pasted diff has no base tree to check, so it never counts.
 */
export function firstWiredHere(ctx: RuleContext, exp: LiveExperiment): boolean {
  if (ctx.repo.kind === 'diff-only') return false;
  const names = (l: ScannedLine) => l.literals.has(exp.flagKey);
  const evaluates = (l: ScannedLine) => hasHit(l, 'exposure', exp.flagKey);
  const base = ctx.baseLines(exp.flagKey);
  // The flag key is new to the codebase (it may be read through a wrapper Guard does not know).
  if (!base.some(names)) return ctx.added.some(names);
  return ctx.added.some(evaluates) && !base.some(evaluates);
}

/** Quote-aware check: does the line contain the literal as a quoted string? */
export function hasLiteral(l: ScannedLine, value: string): boolean {
  return l.literals.has(value);
}

export function closest<T extends { line: number }>(items: T[], line: number): T | undefined {
  return [...items].sort((a, b) => Math.abs(a.line - line) - Math.abs(b.line - line))[0];
}

export function trimEvidence(text: string): string {
  const t = text.trim();
  return t.length > 160 ? `${t.slice(0, 157)}...` : t;
}
