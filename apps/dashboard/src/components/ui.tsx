import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ExperimentStatus, Severity, SeveritySetting, Verdict } from '../lib/api.ts';
import { STATUS_LABEL, VERDICT_LABEL, timeAgo } from '../lib/format.ts';
import { useInterval, useKey } from '../lib/hooks.ts';
import { Icon } from './Icons.tsx';
import type { IconName } from './Icons.tsx';

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(' ');

/* ---------- status chips: always icon + label, never colour alone ---------- */

export const VERDICT_ICON: Record<Verdict, IconName> = { pass: 'check', warn: 'alert', block: 'octagon', overridden: 'unlock' };

export function VerdictChip({ verdict, compact = false }: { verdict: Verdict; compact?: boolean }) {
  return (
    <span className={cx('chip', `v-${verdict}`)} title={VERDICT_LABEL[verdict]}>
      <Icon name={VERDICT_ICON[verdict]} size={12} strokeWidth={2.2} />
      {!compact && VERDICT_LABEL[verdict]}
    </span>
  );
}

export function SeverityChip({ severity }: { severity: Severity | SeveritySetting }) {
  const cls = severity === 'block' ? 'v-block' : severity === 'warn' ? 'v-warn' : severity === 'info' ? 'v-info' : '';
  const icon: IconName = severity === 'block' ? 'octagon' : severity === 'warn' ? 'alert' : severity === 'info' ? 'info' : 'x';
  return (
    <span className={cx('chip', cls)}>
      <Icon name={icon} size={12} strokeWidth={2.2} />
      {severity === 'off' ? 'Off' : severity[0].toUpperCase() + severity.slice(1)}
    </span>
  );
}

export function StatusChip({ status }: { status: ExperimentStatus }) {
  const cls = status === 'running' ? 'v-pass' : status === 'draft' ? 'v-info' : status === 'paused' ? 'v-warn' : '';
  return (
    <span className={cx('chip', cls)}>
      {status === 'running' ? <span className="pulse" style={{ width: 6, height: 6 }} /> : <span className="dot" />}
      {STATUS_LABEL[status]}
    </span>
  );
}

/* ---------- layout ---------- */

export function Card({ title, sub, actions, children, className, pad = true, style }: {
  title?: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string; pad?: boolean; style?: CSSProperties;
}) {
  return (
    <section className={cx('card', className)} style={style}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <div className="card-title">{title}</div>}
            {sub && <div className="card-sub">{sub}</div>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={pad ? 'card-pad' : undefined}>{children}</div>
    </section>
  );
}

/** A titled page section: one idea per section, with room around it. */
export function Section({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <div className="section-head">
        <div>
          <h2 className="section-h">{title}</h2>
          {sub && <div className="section-sub">{sub}</div>}
        </div>
        {actions && <div className="row wrap" style={{ gap: 10 }}>{actions}</div>}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

/* The hero banner at the top of the app has a slot that each page fills with its own header. */
const HeroSlotCtx = createContext<HTMLElement | null>(null);
export const HeroSlotProvider = HeroSlotCtx.Provider;

export function HeroPortal({ children }: { children: ReactNode }) {
  const el = useContext(HeroSlotCtx);
  return el ? createPortal(children, el) : null;
}

export function PageHead({ title, sub, actions }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <HeroPortal>
      <div className="hero-body fade-in">
        <div>
          <h1 className="page-title">{title}</h1>
          {sub && <div className="page-sub">{sub}</div>}
        </div>
        {actions && <div className="row wrap">{actions}</div>}
      </div>
    </HeroPortal>
  );
}

export function Seg<T extends string>({ value, options, onChange, className, size }: {
  value: T;
  options: Array<{ value: T; label: ReactNode; className?: string; title?: string }>;
  onChange: (v: T) => void;
  className?: string;
  size?: 'sm';
}) {
  return (
    <div className={cx('seg', className)} role="radiogroup">
      {options.map(o => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          className={cx(o.value === value && 'on', o.className)}
          style={size === 'sm' ? { height: 24, padding: '0 9px', fontSize: 12 } : undefined}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange }: {
  value: T; tabs: Array<{ value: T; label: ReactNode; icon?: IconName; count?: number }>; onChange: (v: T) => void;
}) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(t => (
        <button key={t.value} type="button" role="tab" aria-selected={t.value === value} className={cx(t.value === value && 'on')} onClick={() => onChange(t.value)}>
          {t.icon && <Icon name={t.icon} size={15} />}
          {t.label}
          {t.count !== undefined && <span className="chip" style={{ height: 18, padding: '0 6px', fontSize: 11 }}>{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  useKey(e => { if (open && e.key === 'Escape') onClose(); });
  if (!open) return null;
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true">{children}</aside>
    </>
  );
}

export function Empty({ icon = 'sparkles', title, children }: { icon?: IconName; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon-wrap"><Icon name={icon} size={20} /></div>
      <div style={{ fontWeight: 600, color: 'var(--text)' }}>{title}</div>
      {children && <div className="small" style={{ maxWidth: 380 }}>{children}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="card fade-in">
      <Empty icon="alert" title="Something went wrong">
        <div style={{ marginBottom: 12 }}>{error.message}</div>
        {onRetry && <button className="btn sm" onClick={onRetry}><Icon name="refresh" size={14} />Try again</button>}
      </Empty>
    </div>
  );
}

export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} />;
}

export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  const [, tick] = useState(0);
  useInterval(() => tick(t => t + 1), 30_000);
  return <time className={className} dateTime={iso} title={new Date(iso).toLocaleString()}>{timeAgo(iso)}</time>;
}

export function CopyButton({ text, label = 'Copy', className, onCopy }: { text: string; label?: string; className?: string; onCopy?: () => void }) {
  const [done, setDone] = useState(false);
  const toast = useToast();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      onCopy?.();
      setDone(true);
      setTimeout(() => setDone(false), 1400);
    } catch {
      toast({ kind: 'warn', title: 'Clipboard unavailable', body: 'Select the text and copy it by hand.' });
    }
  };
  return (
    <button type="button" className={cx('btn sm', className)} onClick={copy}>
      <Icon name={done ? 'check' : 'copy'} size={13} />
      {done ? 'Copied' : label}
    </button>
  );
}

export function CodeBlock({ code, title, lang, onCopy }: { code: string; title?: ReactNode; lang?: string; onCopy?: () => void }) {
  return (
    <div className="card" style={{ overflow: 'hidden', boxShadow: 'none' }}>
      <div className="snippet-head">
        <span className="row"><Icon name={lang === 'yaml' || lang === 'json' ? 'file' : 'terminal'} size={14} />{title}</span>
        <CopyButton text={code} onCopy={onCopy} />
      </div>
      <pre className="code" style={{ border: 0, borderRadius: 0, margin: 0 }}>{code}</pre>
    </div>
  );
}

/* ---------- toasts ---------- */

export interface ToastInput {
  kind?: 'info' | 'pass' | 'warn' | 'block';
  title: string;
  body?: ReactNode;
  onClick?: () => void;
  ms?: number;
}
interface ToastItem extends ToastInput { id: number }

const ToastCtx = createContext<(t: ToastInput) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);
  const push = useCallback((t: ToastInput) => {
    const id = ++idRef.current;
    setItems(list => [...list.slice(-3), { ...t, id }]);
    setTimeout(() => setItems(list => list.filter(x => x.id !== id)), t.ms ?? 4500);
  }, []);
  const icon: Record<NonNullable<ToastInput['kind']>, IconName> = { info: 'info', pass: 'check', warn: 'alert', block: 'octagon' };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {items.map(t => (
          <div
            key={t.id}
            className="toast"
            style={{ cursor: t.onClick ? 'pointer' : undefined }}
            onClick={() => { t.onClick?.(); setItems(list => list.filter(x => x.id !== t.id)); }}
          >
            <span className={cx('feed-badge', `v-${t.kind === 'block' ? 'block' : t.kind === 'warn' ? 'warn' : t.kind === 'pass' ? 'pass' : 'info'}`)} style={{ width: 26, height: 26 }}>
              <Icon name={icon[t.kind ?? 'info']} size={14} strokeWidth={2.2} />
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="toast-title">{t.title}</div>
              {t.body && <div className="toast-body">{t.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------- small helpers ---------- */

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useInterval(() => setNow(Date.now()), ms);
  return now;
}

export function useCountUp(target: number, ms = 700) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      const e = 1 - Math.pow(1 - k, 3);
      setV(a + (target - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = target;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

export function useStable<T>(value: T): T {
  // Keeps object identity stable across renders when deep-equal (cheap JSON compare).
  const ref = useRef(value);
  const key = JSON.stringify(value);
  return useMemo(() => { ref.current = value; return value; }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
