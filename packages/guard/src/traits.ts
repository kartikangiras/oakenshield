// Finds where code sends Flagsmith traits, so rules can tell when the traits that
// decide an experiment's audience (segment rules) stop being sent or change value.

export interface TraitAssignment {
  key: string;
  /** The value expression as written, whitespace-normalised. */
  value: string;
  line: number;
  /** The full source line holding the key, for evidence and suggestions. */
  text: string;
}

export interface NumberedLine { line: number; text: string }

const ANCHORS: Array<{ re: RegExp; kind: 'pair' | 'object' | 'call-object' }> = [
  // flagsmith.setTrait('plan', user.plan)  /  setTrait("plan", ...)
  { re: /\bset_?[Tt]rait\s*\(\s*(['"`])([\w.:-]+)\1\s*,/g, kind: 'pair' },
  // setTraits({ ... }), identify(id, { ... }), getIdentityFlags(id, { ... }), get_identity_flags(id, traits={ ... })
  { re: /\b(?:set_?[Tt]raits|identify|getIdentityFlags|get_identity_flags)\s*\(/g, kind: 'call-object' },
  // traits: { ... }  /  traits = { ... }  /  traits={ ... }
  { re: /\btraits\s*[:=]\s*\{/g, kind: 'object' },
];

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Index of the bracket that closes the one at `open`, honouring strings; -1 if unbalanced. */
function matchClose(src: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1]))) { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Splits `a, b(c, d), e` at top-level commas, keeping each part's start offset. */
function splitTop(src: string, start: number, end: number): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let quote: string | null = null;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push({ text: src.slice(from, i), at: from }); from = i + 1; }
  }
  out.push({ text: src.slice(from, end), at: from });
  return out.filter(p => p.text.trim().length > 0);
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Every trait key set in this version of a file, with the line it is on. */
export function extractTraits(lines: NumberedLine[]): TraitAssignment[] {
  if (lines.length === 0) return [];
  const src = lines.map(l => l.text).join('\n');
  const starts: number[] = [];
  let off = 0;
  for (const l of lines) { starts.push(off); off += l.text.length + 1; }
  const at = (offset: number) => lines[lineAt(starts, offset)];
  const out: TraitAssignment[] = [];
  const seen = new Set<string>();
  const push = (key: string, value: string, offset: number) => {
    const l = at(offset);
    const id = `${key}@${l.line}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ key, value: norm(value), line: l.line, text: l.text });
  };

  const readObject = (open: number) => {
    const close = matchClose(src, open);
    if (close < 0) return;
    for (const part of splitTop(src, open + 1, close)) {
      const t = part.text;
      const lead = t.length - t.trimStart().length;
      const body = t.trim();
      if (body.startsWith('...') || body.startsWith('**')) continue;
      const m = /^(['"`]?)([A-Za-z_$][\w$.:-]*)\1\s*:\s*([\s\S]*)$/.exec(body);
      if (m) { push(m[2], m[3], part.at + lead); continue; }
      const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(body);
      if (shorthand) push(shorthand[1], shorthand[1], part.at + lead);
    }
  };

  for (const a of ANCHORS) {
    a.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = a.re.exec(src))) {
      if (a.kind === 'pair') {
        const close = matchClose(src, src.lastIndexOf('(', m.index + m[0].length));
        const value = close > 0 ? src.slice(m.index + m[0].length, close) : '';
        push(m[2], value, m.index);
      } else if (a.kind === 'object') {
        readObject(m.index + m[0].length - 1);
      } else {
        const open = m.index + m[0].length - 1;
        const close = matchClose(src, open);
        if (close < 0) continue;
        // the first object literal passed to the call, at any argument position
        for (const arg of splitTop(src, open + 1, close)) {
          const body = arg.text.trim();
          const kw = /^(?:traits\s*=\s*)?\{/.exec(body);
          if (kw) { readObject(arg.at + arg.text.indexOf('{')); break; }
        }
      }
    }
  }
  return out.sort((x, y) => x.line - y.line);
}
