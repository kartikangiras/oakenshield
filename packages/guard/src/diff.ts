import type { DiffLine, FileDiff, Hunk } from './types.ts';

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

function cleanPath(p: string): string | null {
  const t = p.trim().replace(/^"(.*)"$/, '$1');
  if (t === '/dev/null') return null;
  return t.replace(/^[ab]\//, '');
}

function finish(fd: FileDiff | null, out: FileDiff[]) {
  if (!fd) return;
  fd.path = fd.newPath ?? fd.oldPath ?? fd.path;
  if (fd.status === 'modified' && fd.oldPath && fd.newPath && fd.oldPath !== fd.newPath) fd.status = 'renamed';
  if (fd.oldPath === null && fd.newPath !== null) fd.status = 'added';
  if (fd.newPath === null && fd.oldPath !== null) fd.status = 'deleted';
  out.push(fd);
}

function blank(): FileDiff {
  return { oldPath: '', newPath: '', path: '', status: 'modified', binary: false, hunks: [] };
}

/** Parses `git diff` / unified diff text. Tolerates diffs without `diff --git` headers. */
export function parseUnifiedDiff(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fd: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let remOld = 0;
  let remNew = 0;
  let oldNo = 0;
  let newNo = 0;

  for (const line of lines) {
    if (hunk && (remOld > 0 || remNew > 0)) {
      const tag = line[0];
      const body = line.slice(1);
      if (tag === ' ' || (tag === undefined && line === '')) {
        hunk.lines.push({ kind: 'ctx', text: body, oldLine: oldNo++, newLine: newNo++ });
        remOld--; remNew--;
        continue;
      }
      if (tag === '-') { hunk.lines.push({ kind: 'del', text: body, oldLine: oldNo++ }); remOld--; continue; }
      if (tag === '+') { hunk.lines.push({ kind: 'add', text: body, newLine: newNo++ }); remNew--; continue; }
      if (tag === '\\') continue;
      // Malformed hunk: fall through and treat the line as a header.
      remOld = 0; remNew = 0;
    }
    if (line.startsWith('\\')) continue;

    if (line.startsWith('diff --git ')) {
      finish(fd, out);
      fd = blank();
      hunk = null;
      const m = line.match(/^diff --git (?:"?a\/)?(.+?)"? (?:"?b\/)(.+?)"?$/);
      if (m) { fd.oldPath = m[1]; fd.newPath = m[2]; fd.path = m[2]; }
      continue;
    }
    if (line.startsWith('--- ')) {
      if (!fd || fd.hunks.length > 0) { finish(fd, out); fd = blank(); }
      fd.oldPath = cleanPath(line.slice(4));
      hunk = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (!fd) fd = blank();
      fd.newPath = cleanPath(line.slice(4));
      continue;
    }
    if (!fd) continue;
    if (line.startsWith('new file mode')) { fd.oldPath = null; fd.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { fd.newPath = null; fd.status = 'deleted'; continue; }
    if (line.startsWith('rename from ')) { fd.oldPath = line.slice(12); fd.status = 'renamed'; continue; }
    if (line.startsWith('rename to ')) { fd.newPath = line.slice(10); fd.status = 'renamed'; continue; }
    if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { fd.binary = true; continue; }
    const m = line.match(HUNK_RE);
    if (m) {
      hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: m[5] || undefined,
        lines: [],
      };
      fd.hunks.push(hunk);
      remOld = hunk.oldLines;
      remNew = hunk.newLines;
      oldNo = hunk.oldStart;
      newNo = hunk.newStart;
    }
  }
  finish(fd, out);
  return out.filter(f => f.path !== '');
}

export function addedLines(fd: FileDiff): Array<{ line: number; text: string }> {
  return fd.hunks.flatMap(h => h.lines.filter(l => l.kind === 'add').map(l => ({ line: l.newLine!, text: l.text })));
}

export function removedLines(fd: FileDiff): Array<{ line: number; text: string }> {
  return fd.hunks.flatMap(h => h.lines.filter(l => l.kind === 'del').map(l => ({ line: l.oldLine!, text: l.text })));
}

function splitLines(s: string | null): string[] {
  if (s === null || s === '') return [];
  const lines = s.replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type Op = { kind: 'ctx' | 'add' | 'del'; text: string };

/** Line diff by longest common subsequence. Fine for source files of a few thousand lines. */
function diffOps(a: string[], b: string[]): Op[] {
  // Trim common prefix and suffix first: most edits are small.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length;
  const m = B.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = a.slice(0, pre).map(text => ({ kind: 'ctx' as const, text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { ops.push({ kind: 'ctx', text: A[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ kind: 'del', text: A[i] }); i++; }
    else { ops.push({ kind: 'add', text: B[j] }); j++; }
  }
  while (i < n) ops.push({ kind: 'del', text: A[i++] });
  while (j < m) ops.push({ kind: 'add', text: B[j++] });
  for (const text of a.slice(a.length - suf)) ops.push({ kind: 'ctx', text });
  return ops;
}

/** Builds a FileDiff from two versions of a file (null = absent). */
export function computeFileDiff(path: string, before: string | null, after: string | null, context = 3): FileDiff | null {
  if (before === after) return null;
  const ops = diffOps(splitLines(before), splitLines(after));
  const numbered: DiffLine[] = [];
  let o = 1;
  let nn = 1;
  for (const op of ops) {
    if (op.kind === 'ctx') numbered.push({ kind: 'ctx', text: op.text, oldLine: o++, newLine: nn++ });
    else if (op.kind === 'del') numbered.push({ kind: 'del', text: op.text, oldLine: o++ });
    else numbered.push({ kind: 'add', text: op.text, newLine: nn++ });
  }
  const changeIdx = numbered.map((l, i) => (l.kind === 'ctx' ? -1 : i)).filter(i => i >= 0);
  const hunks: Hunk[] = [];
  let start = -1;
  let end = -1;
  const flush = () => {
    if (start < 0) return;
    const lines = numbered.slice(start, end + 1);
    const firstOld = lines.find(l => l.oldLine !== undefined)?.oldLine;
    const firstNew = lines.find(l => l.newLine !== undefined)?.newLine;
    const oldLines = lines.filter(l => l.kind !== 'add').length;
    const newLines = lines.filter(l => l.kind !== 'del').length;
    const prevOld = numbered.slice(0, start).filter(l => l.oldLine !== undefined).length;
    const prevNew = numbered.slice(0, start).filter(l => l.newLine !== undefined).length;
    hunks.push({
      oldStart: oldLines === 0 ? prevOld : firstOld ?? prevOld + 1,
      oldLines,
      newStart: newLines === 0 ? prevNew : firstNew ?? prevNew + 1,
      newLines,
      lines,
    });
  };
  for (const idx of changeIdx) {
    const s = Math.max(0, idx - context);
    const e = Math.min(numbered.length - 1, idx + context);
    if (start >= 0 && s <= end + 1) end = Math.max(end, e);
    else { flush(); start = s; end = e; }
  }
  flush();
  const status: FileDiff['status'] = before === null ? 'added' : after === null ? 'deleted' : 'modified';
  return {
    oldPath: before === null ? null : path,
    newPath: after === null ? null : path,
    path,
    status,
    binary: false,
    hunks,
  };
}

/** Diffs two file maps (path -> content). */
export function diffTrees(base: Record<string, string>, head: Record<string, string>): FileDiff[] {
  const paths = [...new Set([...Object.keys(base), ...Object.keys(head)])].sort();
  const out: FileDiff[] = [];
  for (const p of paths) {
    const fd = computeFileDiff(p, base[p] ?? null, head[p] ?? null);
    if (fd) out.push(fd);
  }
  return out;
}

/** Renders FileDiffs back to unified diff text (git style). */
export function formatUnifiedDiff(files: FileDiff[]): string {
  const out: string[] = [];
  for (const f of files) {
    const a = f.oldPath ?? f.path;
    const b = f.newPath ?? f.path;
    out.push(`diff --git a/${a} b/${b}`);
    if (f.status === 'added') out.push('new file mode 100644');
    if (f.status === 'deleted') out.push('deleted file mode 100644');
    out.push(`--- ${f.oldPath ? `a/${f.oldPath}` : '/dev/null'}`);
    out.push(`+++ ${f.newPath ? `b/${f.newPath}` : '/dev/null'}`);
    for (const h of f.hunks) {
      out.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@${h.header ? ` ${h.header}` : ''}`);
      for (const l of h.lines) out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
    }
  }
  return out.length ? `${out.join('\n')}\n` : '';
}
