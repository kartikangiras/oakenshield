import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icons.tsx';
import { Card, ErrorState, PageHead, Seg, Skeleton, cx, useToast } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { RuleView, SeveritySetting } from '../lib/api.ts';
import { navigate, useAsync } from '../lib/hooks.ts';
import { useLive } from '../lib/live.tsx';

const CATEGORY_LABEL: Record<string, string> = {
  conversions: 'Conversion events',
  exposures: 'Exposure',
  sdk: 'SDK & config',
  treatment: 'Treatment code',
  identity: 'Identity',
  audience: 'Audience',
  hygiene: 'Hygiene',
};

export function RulesPage({ focus }: { focus?: string }) {
  const { tick } = useLive();
  const rules = useAsync(() => api.rules(), [tick]);
  const [open, setOpen] = useState<string | null>(focus ?? null);
  const toast = useToast();
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (focus) setOpen(focus); }, [focus]);
  useEffect(() => {
    if (focus && rules.data) focusRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focus, rules.data]);

  const change = async (r: RuleView, severity: SeveritySetting) => {
    const prev = r.severity;
    rules.setData(list => list?.map(x => (x.id === r.id ? { ...x, severity } : x)));
    try {
      await api.setRule(r.id, severity);
      toast({
        kind: severity === 'block' ? 'block' : severity === 'warn' ? 'warn' : 'info',
        title: `${r.id} now ${severity === 'off' ? 'disabled' : `set to ${severity}`}`,
        body: 'Applies to new dashboard and playground checks. Mirror it in .experiment-guard.yml for CI.',
      });
    } catch (e) {
      rules.setData(list => list?.map(x => (x.id === r.id ? { ...x, severity: prev } : x)));
      toast({ kind: 'block', title: 'Could not save', body: (e as Error).message });
    }
  };

  const changed = (rules.data ?? []).filter(r => r.severity !== r.defaultSeverity);
  const yaml = changed.length ? `rules:\n${changed.map(r => `  ${r.id}: ${r.severity}`).join('\n')}\n` : '';

  return (
    <div className="fade-in">
      <PageHead
        title="Rules"
        sub="Thirteen checks for the ways a code change can quietly corrupt a running experiment. Only deterministic rules block by default."
        actions={changed.length > 0 && (
          <button className="btn" onClick={() => { navigator.clipboard?.writeText(yaml); toast({ kind: 'pass', title: 'Copied rule overrides', body: 'Paste into .experiment-guard.yml' }); }}>
            <Icon name="copy" size={14} />Copy as YAML ({changed.length})
          </button>
        )}
      />
      {rules.error && !rules.data ? <ErrorState error={rules.error} onRetry={rules.reload} /> : (
        <Card pad={false}>
          <div className="rule-row faint small" style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 12 }}>
            <span>Rule</span><span>What it catches</span><span className="hide-sm">Category</span><span className="hide-sm">Fired · 30 days</span><span>Severity</span>
          </div>
          {!rules.data ? <div className="card-pad stack">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} h={42} />)}</div> : rules.data.map(r => {
            const isOpen = open === r.id;
            return (
              <div key={r.id} ref={focus === r.id ? focusRef : undefined} style={focus === r.id ? { background: 'var(--brand-soft)' } : undefined}>
                <div className="rule-row" style={{ cursor: 'pointer' }} onClick={() => setOpen(isOpen ? null : r.id)}>
                  <span className="row" style={{ gap: 8 }}>
                    <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={14} style={{ color: 'var(--text-3)' }} />
                    <span className="mono" style={{ fontWeight: 600 }}>{r.id}</span>
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 500 }}>{r.title}</div>
                    <div className="row small faint" style={{ gap: 8, marginTop: 2 }}>
                      {r.deterministic
                        ? <span className="row" style={{ gap: 4 }}><Icon name="lock" size={12} />deterministic</span>
                        : <span className="row" style={{ gap: 4 }}><Icon name="eye" size={12} />heuristic</span>}
                      <span>· default {r.defaultSeverity}</span>
                      {r.severity !== r.defaultSeverity && <span className="chip v-brand" style={{ height: 20, fontSize: 12 }}>changed</span>}
                    </div>
                  </span>
                  <span className="small muted hide-sm">{CATEGORY_LABEL[r.category] ?? r.category}</span>
                  <span className="hide-sm">
                    <button className="btn ghost sm" disabled={r.hits30d === 0} onClick={e => { e.stopPropagation(); navigate(`/checks?rule=${r.id}`); }}>
                      <b className="tnum">{r.hits30d}</b><span className="faint">checks</span>
                    </button>
                  </span>
                  <span onClick={e => e.stopPropagation()}>
                    <Seg<SeveritySetting>
                      className="sev"
                      size="sm"
                      value={r.severity}
                      onChange={v => change(r, v)}
                      options={[
                        { value: 'block', label: 'Block', className: 's-block', title: r.deterministic ? 'Fail the check' : 'Heuristic rules can produce false positives. Blocking is allowed but not recommended.' },
                        { value: 'warn', label: 'Warn', className: 's-warn' },
                        { value: 'info', label: 'Info', className: 's-info' },
                        { value: 'off', label: 'Off' },
                      ]}
                    />
                  </span>
                </div>
                {isOpen && (
                  <div className="rule-row fade-in" style={{ borderTop: 0, paddingTop: 0 }}>
                    <span />
                    <div className={cx('rule-detail')}>
                      <div><b>Fires when</b>{r.firesWhen}</div>
                      <div><b>Why it matters</b>{r.consequence}</div>
                      <div><b>How to fix</b>{r.fix}</div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}
      <div className="small faint row" style={{ marginTop: 16, gap: 8 }}>
        <Icon name="info" size={14} />
        Silence one line in code with <code className="mono">// experiment-guard-ignore EG006: reason</code>. A reason is required.
      </div>
    </div>
  );
}
