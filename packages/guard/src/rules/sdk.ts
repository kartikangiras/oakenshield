import { FLUSH_RE, hasHit } from '../scanner.ts';
import { trimEvidence, type RawFinding, type Rule } from './context.ts';

/** EG003: events switched off in a Flagsmith client. */
export const eg003: Rule = ctx => {
  if (ctx.running.length === 0) return [];
  const out: RawFinding[] = [];
  const reEnabled = ctx.added.some(l => hasHit(l, 'events', 'true'));
  const exp = ctx.running[0];
  const scope = ctx.running.length === 1 ? `"${exp.name}"` : `${ctx.running.length} running experiments`;
  if (!reEnabled) {
    for (const r of ctx.removed.filter(l => hasHit(l, 'events', 'true'))) {
      out.push({
        rule: 'EG003',
        experiment: ctx.running.length === 1 ? exp : null,
        file: r.file,
        line: r.line,
        side: 'removed',
        evidence: `- ${trimEvidence(r.text)}`,
        consequence: `Events are no longer enabled here. Every exposure and conversion from this app stops, which freezes ${scope}.`,
      });
    }
  }
  for (const a of ctx.added.filter(l => hasHit(l, 'events', 'false'))) {
    out.push({
      rule: 'EG003',
      experiment: ctx.running.length === 1 ? exp : null,
      file: a.file,
      line: a.line,
      side: 'added',
      evidence: `+ ${trimEvidence(a.text)}`,
      consequence: `Events are switched off. Every exposure and conversion from this app stops, which freezes ${scope}.`,
      suggestion: {
        file: a.file,
        line: a.line,
        original: a.text,
        replacement: a.text.replace(/enableEvents(\s*):(\s*)false/, 'enableEvents$1:$2true').replace(/enable_events(\s*)=(\s*)False/, 'enable_events$1=$2True'),
      },
    });
  }
  return out;
};

// ---- EG004: SDK versions ----

type Version = [number, number, number];

function parseVersion(spec: string): Version | null {
  const m = spec.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function lessThan(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

interface SdkRule {
  name: string;
  file: RegExp;
  line: RegExp;          // group 1 = version spec
  min: string;
  rewrite: (text: string, min: string) => string;
}

const SDK_RULES: SdkRule[] = [
  {
    name: '@flagsmith/flagsmith', file: /(^|\/)package\.json$/,
    line: /"@flagsmith\/flagsmith"\s*:\s*"([^"]+)"/, min: '12.4.0',
    rewrite: (t, min) => t.replace(/("@flagsmith\/flagsmith"\s*:\s*")[^"]+(")/, `$1^${min}$2`),
  },
  {
    name: '@flagsmith/nodejs', file: /(^|\/)package\.json$/,
    line: /"@flagsmith\/nodejs"\s*:\s*"([^"]+)"/, min: '9.1.0',
    rewrite: (t, min) => t.replace(/("@flagsmith\/nodejs"\s*:\s*")[^"]+(")/, `$1^${min}$2`),
  },
  {
    name: 'flagsmith (Python)', file: /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.cfg)$/,
    line: /^\s*["']?flagsmith(?:\[[^\]]*\])?["']?\s*(?:[=<>~!^]=?|=)\s*["']?[\^~]?\s*(\d+(?:\.\d+){0,2})/, min: '6.3.0',
    rewrite: (t, min) => t.replace(/(\d+(?:\.\d+){0,2})/, min),
  },
  {
    name: 'flagsmith-go-client', file: /(^|\/)go\.mod$/,
    line: /github\.com\/Flagsmith\/flagsmith-go-client(?:\/v\d+)?\s+v(\d+\.\d+\.\d+)/, min: '5.3.0',
    rewrite: (t, min) => t.replace(/(flagsmith-go-client)(?:\/v\d+)?(\s+)v\d+\.\d+\.\d+/, `$1/v${min.split('.')[0]}$2v${min}`),
  },
  {
    name: 'flagsmith-java-client', file: /(^|\/)(build\.gradle(\.kts)?|pom\.xml)$/,
    line: /flagsmith-java-client:(\d+\.\d+\.\d+)/, min: '8.2.0',
    rewrite: (t, min) => t.replace(/(flagsmith-java-client:)\d+\.\d+\.\d+/, `$1${min}`),
  },
  {
    name: 'flagsmith (Flutter)', file: /(^|\/)pubspec\.yaml$/,
    line: /^\s*flagsmith\s*:\s*["']?[\^~>=<]*\s*(\d+\.\d+\.\d+)/, min: '6.2.0',
    rewrite: (t, min) => t.replace(/(\d+\.\d+\.\d+)/, min),
  },
];

/** EG004: an SDK drops below the version that can send events. */
export const eg004: Rule = ctx => {
  if (ctx.running.length === 0) return [];
  const out: RawFinding[] = [];
  for (const a of ctx.added) {
    if (/"flagsmith-nodejs"\s*:/.test(a.text) && /(^|\/)package\.json$/.test(a.file)) {
      out.push({
        rule: 'EG004',
        experiment: null,
        file: a.file,
        line: a.line,
        side: 'added',
        evidence: `+ ${trimEvidence(a.text)}`,
        consequence: 'The legacy flagsmith-nodejs package cannot send events. Exposures and conversions from this service stop.',
        suggestion: { file: a.file, line: a.line, original: a.text, replacement: a.text.replace(/"flagsmith-nodejs"\s*:\s*"[^"]*"/, '"@flagsmith/nodejs": "^9.1.0"') },
      });
      continue;
    }
    for (const sdk of SDK_RULES) {
      if (!sdk.file.test(a.file)) continue;
      const m = a.text.match(sdk.line);
      if (!m) continue;
      const v = parseVersion(m[1]);
      const min = parseVersion(sdk.min)!;
      if (!v || !lessThan(v, min)) continue;
      out.push({
        rule: 'EG004',
        experiment: null,
        file: a.file,
        line: a.line,
        side: 'added',
        evidence: `+ ${trimEvidence(a.text)}`,
        consequence: `${sdk.name} ${m[1]} is older than ${sdk.min}, the first version that sends experiment events. Exposures and conversions from this code stop.`,
        suggestion: { file: a.file, line: a.line, original: a.text, replacement: sdk.rewrite(a.text, sdk.min) },
      });
    }
  }
  return out;
};

const SHORT_LIVED = /(^|\/)(scripts?|bin|jobs?|workers?|functions|lambdas?|handlers?|cron|tasks)\/|(handler|lambda|job|script|worker|cron|task)s?\.[a-z]+$/i;

/** EG010: a short-lived process creates a client with events but never flushes. */
export const eg010: Rule = ctx => {
  const out: RawFinding[] = [];
  const byFile = new Map<string, typeof ctx.added>();
  for (const a of ctx.added) {
    if (!SHORT_LIVED.test(a.file)) continue;
    if (!byFile.has(a.file)) byFile.set(a.file, []);
    byFile.get(a.file)!.push(a);
  }
  for (const [file, lines] of byFile) {
    const enabling = lines.find(l => hasHit(l, 'events', 'true'));
    if (!enabling) continue;
    const content = ctx.headFile(file) ?? lines.map(l => l.text).join('\n');
    if (FLUSH_RE.test(content)) continue;
    out.push({
      rule: 'EG010',
      experiment: null,
      file,
      line: enabling.line,
      side: 'added',
      evidence: `+ ${trimEvidence(enabling.text)}`,
      consequence: 'This looks like a short-lived process. Events are buffered and sent every 10 seconds, so anything still buffered when it exits is lost.',
      hint: enabling.lang === 'py' ? 'Call flagsmith.close() before exit, or set max_buffer_items=1.' : 'Call await flagsmith.close() or flushEvents() before exit.',
    });
  }
  return out;
};
