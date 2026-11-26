import type { Hit, HitKind, Lang, ScannedLine } from './types.ts';

export function langOf(path: string): Lang {
  if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(path)) return 'js';
  if (/\.pyi?$/i.test(path)) return 'py';
  return 'other';
}

interface Pattern {
  kind: HitKind;
  re: RegExp;
  group: number;        // capture group holding the value
}

// Patterns follow the Flagsmith SDK calls documented for Experimentation.
const JS: Pattern[] = [
  { kind: 'exposure', re: /\b(?:getExperimentFlag|useExperiment|trackExposureEvent)\s*\(\s*(['"`])([^'"`\n$]+)\1/g, group: 2 },
  { kind: 'conversion', re: /\btrackEvent\s*\(\s*(['"`])([^'"`\n$]+)\1/g, group: 2 },
  { kind: 'variant', re: /\.variant\s*(?:===|==|!==|!=)\s*(['"`])([^'"`\n]+)\1/g, group: 2 },
  { kind: 'variant', re: /(['"`])([^'"`\n]+)\1\s*(?:===|==|!==|!=)\s*[\w$.?]*\.variant\b/g, group: 2 },
  { kind: 'variant', re: /\bcase\s+(['"`])([^'"`\n]+)\1\s*:/g, group: 2 },
  { kind: 'events', re: /\benableEvents\s*:\s*(true|false)\b/g, group: 1 },
  { kind: 'identity', re: /(\.identify\s*\(|\bidentity\s*[:=](?!=))/g, group: 1 },
  { kind: 'init', re: /(\bnew\s+Flagsmith\s*\(|\bflagsmith\.init\s*\(|<FlagsmithProvider\b)/g, group: 1 },
  { kind: 'dynamic', re: /\b(trackEvent|getExperimentFlag|useExperiment|trackExposureEvent)\s*\(\s*(?:`[^`]*\$\{|[A-Za-z_$][\w$.]*\s*[,)])/g, group: 1 },
];

const PY: Pattern[] = [
  { kind: 'exposure', re: /\b(?:get_experiment_flag|track_exposure_event)\s*\(\s*(['"])([^'"\n]+)\1/g, group: 2 },
  { kind: 'conversion', re: /\btrack_event\s*\(\s*(['"])([^'"\n]+)\1/g, group: 2 },
  { kind: 'variant', re: /\.variant\s*(?:==|!=)\s*(['"])([^'"\n]+)\1/g, group: 2 },
  { kind: 'variant', re: /(['"])([^'"\n]+)\1\s*(?:==|!=)\s*[\w.]*\.variant\b/g, group: 2 },
  { kind: 'events', re: /\benable_events\s*=\s*(True|False)\b/g, group: 1 },
  { kind: 'identity', re: /(\bidentifier\s*=(?!=)|\.identify\s*\()/g, group: 1 },
  { kind: 'init', re: /(\bFlagsmith\s*\()/g, group: 1 },
  { kind: 'dynamic', re: /\b(track_event|get_experiment_flag|track_exposure_event)\s*\(\s*(?:f["']|[A-Za-z_][\w.]*\s*[,)])/g, group: 1 },
];

const LITERAL_RE = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

export const FLUSH_RE = /\b(?:flushEvents|flush_events|flush)\s*\(|\.close\s*\(|max_buffer_items\s*=\s*1\b/;

export function scanText(text: string, lang: Lang): { hits: Hit[]; literals: Set<string> } {
  const hits: Hit[] = [];
  const patterns = lang === 'js' ? JS : lang === 'py' ? PY : [];
  for (const p of patterns) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      let value = m[p.group];
      if (p.kind === 'events') value = value.toLowerCase();
      hits.push({ kind: p.kind, value });
    }
  }
  const literals = new Set<string>();
  for (const m of text.matchAll(LITERAL_RE)) {
    if (m[1] === '`' && m[2].includes('${')) continue;
    literals.add(m[2]);
  }
  for (const l of literals) hits.push({ kind: 'literal', value: l });
  return { hits, literals };
}

export function scanLine(file: string, line: number, text: string, side: ScannedLine['side']): ScannedLine {
  const lang = langOf(file);
  const { hits, literals } = scanText(text, lang);
  return { file, line, text, side, lang, hits, literals };
}

export function hitValues(l: ScannedLine, kind: HitKind): string[] {
  return l.hits.filter(h => h.kind === kind).map(h => h.value);
}

export function hasHit(l: ScannedLine, kind: HitKind, value?: string): boolean {
  return l.hits.some(h => h.kind === kind && (value === undefined || h.value === value));
}

/** Lower-case and drop separators: issue_opened == issueOpened == Issue-Opened. */
export function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** How a changed literal relates to the one it replaced, if it looks like a rename. */
export function renameKind(from: string, to: string): 'style' | 'typo' | null {
  if (from === to) return null;
  if (norm(from) === norm(to)) return 'style';
  const max = Math.max(from.length, to.length);
  if (max >= 5 && levenshtein(from, to) <= 2) return 'typo';
  return null;
}

/** Replaces the quoted literal `from` with `to` in a line, keeping the quote style. */
export function replaceLiteral(text: string, from: string, to: string): string {
  const esc = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(['"\`])${esc}\\1`), (_m, q: string) => `${q}${to}${q}`);
}
