import { inScope, type GuardConfig } from '../config.ts';
import type { RepoView } from '../repo.ts';
import { scanLine } from '../scanner.ts';
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
  return {
    ...opts,
    headLines(literal: string) {
      if (!grepCache.has(literal)) {
        // Only code the guard reads: a README or docs page that names the event does not send it.
        const hits = opts.repo.grep('head', [literal])
          .filter(h => inScope(h.path, opts.config))
          .map(h => scanLine(h.path, h.line, h.text, 'head'));
        grepCache.set(literal, hits);
      }
      return grepCache.get(literal)!;
    },
    headFile(path: string) {
      if (!fileCache.has(path)) fileCache.set(path, opts.repo.read('head', path));
      return fileCache.get(path)!;
    },
  };
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
