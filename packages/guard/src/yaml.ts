// A small YAML subset parser, enough for .experiment-guard.yml:
// nested maps, block lists ("- item", "- key: value"), inline lists ([a, b]),
// quoted and plain scalars, booleans, numbers, null and comments.
// It keeps Experiment Guard free of runtime dependencies.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export class YamlError extends Error {}

interface Line {
  indent: number;
  text: string; // trimmed content, comment removed
  no: number;   // 1-based line number in the source
}

function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(raw[i - 1]))) return raw.slice(0, i);
  }
  return raw;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(["\\nt])/g, (_m, c: string) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

function splitInline(body: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur);
  return parts.map(p => p.trim()).filter(p => p !== '');
}

export function parseScalar(raw: string): YamlValue {
  const t = raw.trim();
  if (t === '' || t === '~' || t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t === '[]') return [];
  if (t === '{}') return {};
  if (t.startsWith('[') && t.endsWith(']')) return splitInline(t.slice(1, -1)).map(parseScalar);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith('"') || t.startsWith("'")) return unquote(t);
  return t;
}

const KEY_RE = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'#][^:]*?)\s*:(?:\s+(.*))?$/;

function isListItem(l: Line): boolean {
  return l.text === '-' || l.text.startsWith('- ');
}

export function parseYaml(src: string): YamlValue {
  const lines: Line[] = [];
  src.split(/\r?\n/).forEach((raw, idx) => {
    if (/\t/.test(raw.match(/^\s*/)?.[0] ?? '')) throw new YamlError(`Line ${idx + 1}: tabs are not allowed for indentation`);
    const text = stripComment(raw).trimEnd();
    const trimmed = text.trim();
    if (trimmed === '' || trimmed === '---' || trimmed === '...') return;
    lines.push({ indent: text.length - text.trimStart().length, text: trimmed, no: idx + 1 });
  });

  let i = 0;

  function parseBlock(indent: number): YamlValue {
    if (i >= lines.length) return null;
    return isListItem(lines[i]) ? parseList(indent) : parseMap(indent);
  }

  function parseMap(indent: number): { [key: string]: YamlValue } {
    const out: { [key: string]: YamlValue } = {};
    while (i < lines.length && lines[i].indent === indent && !isListItem(lines[i])) {
      const line = lines[i];
      const m = line.text.match(KEY_RE);
      if (!m) throw new YamlError(`Line ${line.no}: expected "key: value", got "${line.text}"`);
      const key = unquote(m[1]);
      const rest = m[2];
      i++;
      if (rest === undefined || rest.trim() === '') {
        if (i < lines.length && lines[i].indent > indent) out[key] = parseBlock(lines[i].indent);
        else if (i < lines.length && lines[i].indent === indent && isListItem(lines[i])) out[key] = parseList(indent);
        else out[key] = null;
      } else {
        out[key] = parseScalar(rest);
      }
    }
    if (i < lines.length && lines[i].indent > indent) {
      throw new YamlError(`Line ${lines[i].no}: unexpected indentation`);
    }
    return out;
  }

  function parseList(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (i < lines.length && lines[i].indent === indent && isListItem(lines[i])) {
      const line = lines[i];
      const body = line.text === '-' ? '' : line.text.slice(2).trim();
      if (body === '') {
        i++;
        out.push(i < lines.length && lines[i].indent > indent ? parseBlock(lines[i].indent) : null);
        continue;
      }
      if (KEY_RE.test(body) && !body.startsWith('[')) {
        // "- key: value" starts a map whose keys sit at the column after "- ".
        const childIndent = indent + (line.text.length - body.length);
        lines[i] = { indent: childIndent, text: body, no: line.no };
        out.push(parseMap(childIndent));
        continue;
      }
      i++;
      out.push(parseScalar(body));
    }
    return out;
  }

  if (lines.length === 0) return null;
  const value = parseBlock(lines[0].indent);
  if (i < lines.length) throw new YamlError(`Line ${lines[i].no}: could not parse "${lines[i].text}"`);
  return value;
}
