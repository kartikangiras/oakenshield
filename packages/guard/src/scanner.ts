import type { Hit, HitKind, Lang, ScannedLine } from './types.ts';

export function langOf(path: string): Lang {
  if (/\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i.test(path)) return 'js';
  if (/\.pyi?$/i.test(path)) return 'py';
  return 'other';
}

/** Files that hold values for code to read. A project that keeps its flag keys and event names here passes them to the SDK through a variable. */
export function isConfigFile(path: string): boolean {
  return /\.(?:json[c5]?|ya?ml|toml|ini|properties)$/i.test(path) || /(^|\/)\.env(?:\.[\w.-]+)?$/i.test(path);
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

/** A project's own functions that wrap the SDK (`calls` in .experiment-guard.yml). */
export interface CustomCalls {
  exposure: string[];
  conversion: string[];
}

const customCache = new WeakMap<CustomCalls, Record<'js' | 'py', Pattern[]>>();

function customPatterns(calls: CustomCalls, lang: 'js' | 'py'): Pattern[] {
  let cached = customCache.get(calls);
  if (!cached) {
    const names = (list: string[]) => list.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const build = (quote: string, dynamic: string): Pattern[] => {
      const out: Pattern[] = [];
      for (const kind of ['exposure', 'conversion'] as const) {
        if (calls[kind].length === 0) continue;
        out.push({ kind, re: new RegExp(`(?<![\\w$])(?:${names(calls[kind])})\\s*\\(\\s*([${quote}])([^${quote}\\n$]+)\\1`, 'g'), group: 2 });
      }
      const all = [...calls.exposure, ...calls.conversion];
      if (all.length > 0) out.push({ kind: 'dynamic', re: new RegExp(`(?<![\\w$])(${names(all)})\\s*\\(\\s*(?:${dynamic})`, 'g'), group: 1 });
      return out;
    };
    cached = {
      js: build('\'"`', '`[^`]*\\$\\{|[A-Za-z_$][\\w$.]*\\s*[,)]'),
      py: build('\'"', 'f["\']|[A-Za-z_][\\w.]*\\s*[,)]'),
    };
    customCache.set(calls, cached);
  }
  return cached[lang];
}

const LITERAL_RE = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;

// Config formats leave most names unquoted: `flag: checkout_v2`, `GOAL_EVENT=order_paid`, `- order_paid`.
const BARE_RE = /(?:^\s*(?:-\s+)?|[:=,[{]\s*)([A-Za-z_][\w.-]*)(?=\s*(?:[:=,\]}#]|$))/g;

/** The calls that evaluate or record an experiment flag, by name: what a `dynamic` hit carries when the flag key is a variable. */
export function exposureCalls(calls?: CustomCalls): string[] {
  return ['getExperimentFlag', 'useExperiment', 'trackExposureEvent', 'get_experiment_flag', 'track_exposure_event', ...(calls?.exposure ?? [])];
}

/** The same for the calls that send a conversion event. */
export function conversionCalls(calls?: CustomCalls): string[] {
  return ['trackEvent', 'track_event', ...(calls?.conversion ?? [])];
}

export const FLUSH_RE = /\b(?:flushEvents|flush_events|flush)\s*\(|\.close\s*\(|max_buffer_items\s*=\s*1\b/;

export function scanText(text: string, lang: Lang, calls?: CustomCalls): { hits: Hit[]; literals: Set<string> } {
  const hits: Hit[] = [];
  const builtIn = lang === 'js' ? JS : lang === 'py' ? PY : [];
  const patterns = calls && lang !== 'other' ? [...builtIn, ...customPatterns(calls, lang)] : builtIn;
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

export function scanLine(file: string, line: number, text: string, side: ScannedLine['side'], calls?: CustomCalls): ScannedLine {
  const lang = langOf(file);
  const { hits, literals } = scanText(text, lang, calls);
  if (isConfigFile(file)) {
    for (const m of text.replace(LITERAL_RE, '""').matchAll(BARE_RE)) {
      if (literals.has(m[1])) continue;
      literals.add(m[1]);
      hits.push({ kind: 'literal', value: m[1] });
    }
  }
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
