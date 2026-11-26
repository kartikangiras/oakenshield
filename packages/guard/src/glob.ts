// Minimal glob matching: **, *, ?, {a,b}. Paths use forward slashes.

const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = '';
  let i = 0;
  let inBrace = false;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // "**/" matches zero or more directories; a trailing "**" matches everything.
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; continue; }
        re += '.*'; i += 2; continue;
      }
      re += '[^/]*'; i++; continue;
    }
    if (ch === '?') { re += '[^/]'; i++; continue; }
    if (ch === '{') { inBrace = true; re += '(?:'; i++; continue; }
    if (ch === '}' && inBrace) { inBrace = false; re += ')'; i++; continue; }
    if (ch === ',' && inBrace) { re += '|'; i++; continue; }
    re += /[.+^$()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    i++;
  }
  const out = new RegExp(`^${re}$`);
  cache.set(glob, out);
  return out;
}

export function matchesAny(path: string, globs: string[]): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.some(g => globToRegExp(g).test(p));
}
