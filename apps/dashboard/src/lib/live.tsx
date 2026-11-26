import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '../components/ui.tsx';
import { api } from './api.ts';
import type { CheckSummary, FlagsmithAlert, Health, StreamEvent } from './api.ts';
import { navigate } from './hooks.ts';

interface Live {
  /** True while the event stream is open. */
  connected: boolean;
  /** Bumps on every check or settings change; pages add it to their deps to refetch. */
  tick: number;
  health: Health | undefined;
  healthError: string | undefined;
  recent: CheckSummary[];
  /** Flagsmith alerts, newest first. */
  alerts: FlagsmithAlert[];
  /** Alerts that arrived since the bell was last opened. */
  unread: number;
  markRead: () => void;
  refreshHealth: () => void;
}

const LiveCtx = createContext<Live>({ connected: false, tick: 0, health: undefined, healthError: undefined, recent: [], alerts: [], unread: 0, markRead: () => {}, refreshHealth: () => {} });
export const useLive = () => useContext(LiveCtx);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const [health, setHealth] = useState<Health>();
  const [healthError, setHealthError] = useState<string>();
  const [recent, setRecent] = useState<CheckSummary[]>([]);
  const [alerts, setAlerts] = useState<FlagsmithAlert[]>([]);
  const [seenAt, setSeenAt] = useState<string>(() => {
    try { return localStorage.getItem('oak-alerts-seen') ?? ''; } catch { return ''; }
  });
  const markRead = useCallback(() => {
    const now = new Date().toISOString();
    setSeenAt(now);
    try { localStorage.setItem('oak-alerts-seen', now); } catch { /* storage unavailable */ }
  }, []);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const refreshHealth = useCallback(() => {
    api.health().then(h => { setHealth(h); setHealthError(undefined); }, (e: Error) => setHealthError(e.message));
  }, []);

  useEffect(() => {
    refreshHealth();
    const t = setInterval(refreshHealth, 60_000);
    return () => clearInterval(t);
  }, [refreshHealth]);

  useEffect(() => {
    api.alerts().then(setAlerts, () => {});
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let bump: ReturnType<typeof setTimeout> | undefined;
    const scheduleTick = () => {
      clearTimeout(bump);
      bump = setTimeout(() => setTick(t => t + 1), 250);
    };
    const parse = (e: MessageEvent<string>): StreamEvent | null => {
      try { return JSON.parse(e.data) as StreamEvent; } catch { return null; }
    };
    es = new EventSource('/api/stream');
    es.addEventListener('hello', () => setConnected(true));
    es.addEventListener('check', e => {
      const ev = parse(e as MessageEvent<string>);
      if (ev?.type !== 'check') return;
      const c = ev.check;
      setRecent(list => [c, ...list.filter(x => x.id !== c.id)].slice(0, 20));
      scheduleTick();
      if (c.source !== 'playground' && c.source !== 'webhook' && (c.verdict === 'block' || c.verdict === 'warn')) {
        toastRef.current({
          kind: c.verdict,
          title: `${c.verdict === 'block' ? 'Blocked' : 'Warning on'} ${c.repo}${c.pr?.number ? ` #${c.pr.number}` : ''}`,
          body: `${c.pr?.title ?? 'Pull request'} · ${c.rules.join(', ')}`,
          onClick: () => navigate(`/checks/${c.id}`),
        });
      }
    });
    es.addEventListener('snapshot', () => { refreshHealth(); scheduleTick(); });
    es.addEventListener('alert', e => {
      const ev = parse(e as MessageEvent<string>);
      if (ev?.type !== 'alert') return;
      const a = ev.alert;
      setAlerts(list => [a, ...list.filter(x => x.id !== a.id)].slice(0, 100));
      scheduleTick();
      const target = a.checkIds?.length ? `/checks/${a.checkIds[0]}` : a.experimentId !== undefined ? `/experiments/${a.experimentId}` : undefined;
      toastRef.current({
        kind: a.severity === 'block' ? 'block' : a.severity === 'warn' ? 'warn' : 'info',
        title: a.title,
        body: a.detail,
        ms: a.severity === 'info' ? 5000 : 9000,
        onClick: target ? () => navigate(target) : undefined,
      });
    });
    es.addEventListener('settings', () => scheduleTick());
    es.onerror = () => setConnected(false);
    es.onopen = () => setConnected(true);
    return () => { clearTimeout(bump); es?.close(); };
  }, [refreshHealth]);

  return (
    <LiveCtx.Provider value={{ connected, tick, health, healthError, recent, alerts, unread: alerts.filter(a => a.at > seenAt).length, markRead, refreshHealth }}>
      {children}
    </LiveCtx.Provider>
  );
}
