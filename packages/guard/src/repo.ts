import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffTrees, parseUnifiedDiff } from './diff.ts';
import type { FileDiff } from './types.ts';

export type Rev = 'base' | 'head';

export interface GrepHit {
  path: string;
  line: number;
  text: string;
}

/** Read access to the two versions of a repository that a check compares. */
export interface RepoView {
  readonly kind: 'git' | 'memory' | 'diff-only';
  diff(): FileDiff[];
  read(rev: Rev, path: string): string | null;
  /** Lines containing any of the literals (exact substring match). */
  grep(rev: Rev, literals: string[]): GrepHit[];
}

const WORKTREE = 'WORKTREE';

export class GitRepoView implements RepoView {
  readonly kind = 'git' as const;
  readonly cwd: string;
  readonly base: string;
  readonly head: string;
  private readCache = new Map<string, string | null>();

  constructor(opts: { cwd: string; base: string; head?: string }) {
    this.cwd = opts.cwd;
    this.base = opts.base;
    this.head = opts.head ?? 'HEAD';
  }

  private git(args: string[], allowExit1 = false): string {
    try {
      return execFileSync('git', args, { cwd: this.cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      if (allowExit1 && e.status === 1) return e.stdout ?? '';
      throw new Error(`git ${args.join(' ')} failed: ${(e.stderr ?? String(err)).trim()}`);
    }
  }

  diff(): FileDiff[] {
    const common = ['diff', '--no-color', '--no-ext-diff', '-M', '--unified=3'];
    if (this.head === WORKTREE) return parseUnifiedDiff(this.git([...common, this.base]));
    try {
      return parseUnifiedDiff(this.git([...common, `${this.base}...${this.head}`]));
    } catch {
      // No merge base (shallow clone or unrelated histories): fall back to a two-dot diff.
      return parseUnifiedDiff(this.git([...common, this.base, this.head]));
    }
  }

  read(rev: Rev, path: string): string | null {
    const ref = rev === 'base' ? this.base : this.head;
    const key = `${ref}:${path}`;
    if (this.readCache.has(key)) return this.readCache.get(key)!;
    let content: string | null = null;
    if (ref === WORKTREE) {
      const abs = join(this.cwd, path);
      content = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
    } else {
      try { content = this.git(['show', `${ref}:${path}`]); } catch { content = null; }
    }
    this.readCache.set(key, content);
    return content;
  }

  grep(rev: Rev, literals: string[]): GrepHit[] {
    const lits = [...new Set(literals.filter(Boolean))];
    if (lits.length === 0) return [];
    const ref = rev === 'base' ? this.base : this.head;
    const args = ['grep', '-n', '-I', '-F', '--full-name', '--no-color'];
    for (const l of lits) args.push('-e', l);
    if (ref === WORKTREE) args.push('--untracked');
    else args.push(ref);
    args.push('--');
    const out = this.git(args, true);
    const hits: GrepHit[] = [];
    const prefix = ref === WORKTREE ? '' : `${ref}:`;
    for (const raw of out.split('\n')) {
      if (!raw) continue;
      const rest = prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
      const m = rest.match(/^(.*?):(\d+):(.*)$/);
      if (m) hits.push({ path: m[1], line: Number(m[2]), text: m[3] });
    }
    return hits;
  }
}

/** An in-memory repository: two file maps. Used by tests, the playground and scenarios. */
export class MemoryRepoView implements RepoView {
  readonly kind = 'memory' as const;
  readonly baseFiles: Record<string, string>;
  readonly headFiles: Record<string, string>;
  constructor(baseFiles: Record<string, string>, headFiles: Record<string, string>) {
    this.baseFiles = baseFiles;
    this.headFiles = headFiles;
  }

  diff(): FileDiff[] {
    return diffTrees(this.baseFiles, this.headFiles);
  }

  read(rev: Rev, path: string): string | null {
    const files = rev === 'base' ? this.baseFiles : this.headFiles;
    return files[path] ?? null;
  }

  grep(rev: Rev, literals: string[]): GrepHit[] {
    const files = rev === 'base' ? this.baseFiles : this.headFiles;
    const lits = literals.filter(Boolean);
    const hits: GrepHit[] = [];
    for (const [path, content] of Object.entries(files)) {
      content.split('\n').forEach((text, i) => {
        if (lits.some(l => text.includes(l))) hits.push({ path, line: i + 1, text });
      });
    }
    return hits;
  }
}

/**
 * A pasted diff with no repository behind it. Head-side reads are reconstructed
 * from the diff's own lines, so checks still run; rules that need whole files
 * see only what the diff shows.
 */
export class DiffOnlyRepoView implements RepoView {
  readonly kind = 'diff-only' as const;
  private files: FileDiff[];
  constructor(diffText: string) {
    this.files = parseUnifiedDiff(diffText);
  }
  diff(): FileDiff[] {
    return this.files;
  }
  read(rev: Rev, path: string): string | null {
    const fd = this.files.find(f => (rev === 'head' ? f.newPath : f.oldPath) === path);
    if (!fd) return null;
    const lines: string[] = [];
    for (const h of fd.hunks) {
      for (const l of h.lines) {
        const n = rev === 'head' ? l.newLine : l.oldLine;
        if (n === undefined) continue;
        if (rev === 'head' ? l.kind !== 'del' : l.kind !== 'add') lines[n - 1] = l.text;
      }
    }
    return Array.from(lines, x => x ?? '').join('\n');
  }
  grep(rev: Rev, literals: string[]): GrepHit[] {
    const hits: GrepHit[] = [];
    for (const f of this.files) {
      const path = rev === 'head' ? f.newPath : f.oldPath;
      if (!path) continue;
      for (const h of f.hunks) {
        for (const l of h.lines) {
          const n = rev === 'head' ? l.newLine : l.oldLine;
          if (n === undefined) continue;
          if (literals.some(x => x && l.text.includes(x))) hits.push({ path, line: n, text: l.text });
        }
      }
    }
    return hits;
  }
}
