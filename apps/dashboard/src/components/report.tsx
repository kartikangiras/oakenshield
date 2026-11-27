import { Fragment, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Finding } from '../lib/api.ts';
import { navigate } from '../lib/hooks.ts';
import { Icon } from './Icons.tsx';
import { SeverityChip, cx } from './ui.tsx';

/* ---------- a small, safe Markdown renderer for PR comments (no innerHTML) ---------- */

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(_[^_]+_)|(\[[^\]]+\]\([^)\s]+\))|(@[\w-]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), i)}</strong>);
    else if (m[3]) out.push(<em key={k}>{t.slice(1, -1)}</em>);
    else if (m[4]) {
      const [, label, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(t)!;
      const safe = /^https?:\/\//.test(href) ? href : undefined;
      out.push(<a key={k} className="link" href={safe} target="_blank" rel="noreferrer">{label}</a>);
    } else out.push(<span key={k} style={{ color: 'var(--brand-1)', fontWeight: 500 }}>{t}</span>);
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function DiffCode({ code }: { code: string }) {
  return (
    <pre className="code">
      {code.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'ctx'}>{l || ' '}</span>
      ))}
    </pre>
  );
}

function blocks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t || /^<!--.*-->$/.test(t)) { i++; continue; }
    if (t.startsWith('```')) {
      const lang = t.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      out.push(lang === 'diff' ? <DiffCode key={key++} code={body.join('\n')} /> : <pre key={key++} className="code">{body.join('\n')}</pre>);
      continue;
    }
    const det = /^<details><summary>(.*)<\/summary>$/.exec(t);
    if (det) {
      const body: string[] = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '</details>') body.push(lines[i++]);
      i++;
      out.push(<details key={key++}><summary>{inline(det[1])}</summary><div style={{ marginTop: 12 }}>{blocks(body)}</div></details>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      out.push(h[1].length <= 3 ? <h3 key={key++}>{inline(h[2])}</h3> : <h4 key={key++}>{inline(h[2])}</h4>);
      i++;
      continue;
    }
    const sub = /^<sub>(.*)<\/sub>$/.exec(t);
    if (sub) { out.push(<p key={key++}><small>{inline(sub[1])}</small></p>); i++; continue; }
    if (t.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) body.push(lines[i++].trim().replace(/^>\s?/, ''));
      out.push(<blockquote key={key++}>{inline(body.join(' '))}</blockquote>);
      continue;
    }
    if (/^[-*]\s/.test(t) || /^\d+\.\s/.test(t)) {
      const ordered = /^\d+\./.test(t);
      const items: string[] = [];
      while (i < lines.length && (ordered ? /^\d+\.\s/ : /^[-*]\s/).test(lines[i].trim())) {
        items.push(lines[i++].trim().replace(/^([-*]|\d+\.)\s+/, ''));
      }
      const li = items.map((it, j) => <li key={j}>{inline(it, j)}</li>);
      out.push(ordered ? <ol key={key++}>{li}</ol> : <ul key={key++}>{li}</ul>);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#|```|>|[-*]\s|\d+\.\s|<details|<sub>|<!--)/.test(lines[i].trim())) para.push(lines[i++].trim());
    if (para.length === 0) { i++; continue; }
    out.push(<p key={key++}>{inline(para.join(' '))}</p>);
  }
  return out;
}

export function Markdown({ source }: { source: string }) {
  const nodes = useMemo(() => blocks(source.split('\n')), [source]);
  return <div className="md">{nodes}</div>;
}

/* ---------- unified diff viewer ---------- */

interface DLine { type: 'add' | 'del' | 'ctx' | 'hunk'; text: string; old?: number; new?: number }
interface DFile { path: string; lines: DLine[]; added: number; removed: number }

export function parseDiff(diff: string): DFile[] {
  const files: DFile[] = [];
  let cur: DFile | null = null;
  let o = 0;
  let n = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git')) { cur = null; continue; }
    if (raw.startsWith('--- ')) { continue; }
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).replace(/^b\//, '');
      cur = { path: p === '/dev/null' ? '(deleted)' : p, lines: [], added: 0, removed: 0 };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (h) { o = Number(h[1]); n = Number(h[2]); cur.lines.push({ type: 'hunk', text: raw }); continue; }
    if (raw.startsWith('+')) { cur.lines.push({ type: 'add', text: raw.slice(1), new: n++ }); cur.added++; }
    else if (raw.startsWith('-')) { cur.lines.push({ type: 'del', text: raw.slice(1), old: o++ }); cur.removed++; }
    else if (raw.startsWith(' ') || raw === '') {
      if (raw === '' && cur.lines.length && cur.lines[cur.lines.length - 1].type === 'hunk') continue;
      cur.lines.push({ type: 'ctx', text: raw.slice(1), old: o++, new: n++ });
    }
  }
  // drop trailing empty context created by the final newline
  for (const f of files) while (f.lines.length && f.lines[f.lines.length - 1].type === 'ctx' && f.lines[f.lines.length - 1].text === '') f.lines.pop();
  return files;
}

export function DiffView({ diff, findings = [] }: { diff: string; findings?: Finding[] }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const flagged = useMemo(() => {
    const s = new Set<string>();
    for (const f of findings) s.add(`${f.file}:${f.side === 'removed' ? 'old' : 'new'}:${f.line}`);
    return s;
  }, [findings]);
  if (files.length === 0) return <div className="faint small">No diff recorded for this check.</div>;
  return (
    <div>
      {files.map(f => (
        <div key={f.path} className="diff">
          <div className="diff-file">
            <Icon name="file" size={14} />
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.path}</span>
            <span style={{ color: 'var(--pass)' }}>+{f.added}</span>
            <span style={{ color: 'var(--block)' }}>−{f.removed}</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <tbody>
                {f.lines.map((l, i) => {
                  const hit = (l.type === 'del' && flagged.has(`${f.path}:old:${l.old}`)) || (l.type !== 'del' && l.new !== undefined && flagged.has(`${f.path}:new:${l.new}`));
                  return (
                    <tr key={i} className={cx(l.type, hit && 'flag')}>
                      {l.type === 'hunk' ? (
                        <td colSpan={3}>{l.text}</td>
                      ) : (
                        <>
                          <td className="ln">{l.old ?? ''}</td>
                          <td className="ln">{l.new ?? ''}</td>
                          <td>{l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  '}{l.text}</td>
                        </>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------- a finding, as the dashboard shows it ---------- */

export function FindingCard({ f }: { f: Finding }) {
  return (
    <article className={cx('finding', `sev-${f.severity}`, f.ignoredBecause && 'ignored')}>
      <header className="finding-head">
        <SeverityChip severity={f.severity} />
        <span className="chip mono" style={{ cursor: 'pointer' }} onClick={() => navigate(`/rules?focus=${f.rule}`)}>{f.rule}</span>
        <b style={{ fontWeight: 600 }}>{f.title}</b>
        <span className="spacer" />
        <span className="mono small faint">{f.file}:{f.line}</span>
      </header>
      <div className="finding-body">
        {f.experimentName && (
          <div className="row small muted">
            <Icon name="flask" size={14} />
            <span>{f.experimentName}</span>
            {f.flagKey && <span className="chip mono">{f.flagKey}</span>}
          </div>
        )}
        <DiffCode code={f.evidence} />
        <div>{f.consequence}</div>
        {f.hint && <div className="muted small row" style={{ alignItems: 'flex-start' }}><Icon name="info" size={14} style={{ marginTop: 2, flex: 'none' }} />{f.hint}</div>}
        {f.aiNote && <div className="muted small row" style={{ alignItems: 'flex-start' }}><Icon name="sparkles" size={14} style={{ marginTop: 2, flex: 'none' }} />{f.aiNote}</div>}
        {f.ignoredBecause && <div className="small row"><Icon name="eye" size={14} />Ignored in code: “{f.ignoredBecause}”</div>}
        {f.suggestion && (
          <div className="suggest">
            <div className="suggest-head"><Icon name="wand" size={14} />Suggested change · line {f.suggestion.line}</div>
            <DiffCode code={`-${f.suggestion.original}\n+${f.suggestion.replacement}`} />
          </div>
        )}
      </div>
    </article>
  );
}

export function FindingsList({ findings }: { findings: Finding[] }) {
  const order = { block: 0, warn: 1, info: 2 } as const;
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  return <div className="stack" style={{ gap: 12 }}>{sorted.map(f => <Fragment key={f.id}><FindingCard f={f} /></Fragment>)}</div>;
}
