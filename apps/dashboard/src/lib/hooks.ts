import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

/* ---------- async data ---------- */

export interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  reload: () => void;
  setData: (fn: (prev: T | undefined) => T | undefined) => void;
}

/** Loads data and reloads when deps change. Keeps stale data visible while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setDataState] = useState<T | undefined>(undefined);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    setLoading(true);
    fnRef.current().then(
      d => { if (alive) { setDataState(d); setError(undefined); setLoading(false); } },
      (e: unknown) => { if (alive) { setError(e instanceof Error ? e : new Error(String(e))); setLoading(false); } },
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  const setData = useCallback((f: (prev: T | undefined) => T | undefined) => setDataState(prev => f(prev)), []);
  return { data, error, loading, reload, setData };
}

/* ---------- hash router ---------- */

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

const readRoute = (): Route => {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(search) };
};

let current = readRoute();
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = readRoute();
  listeners.forEach(l => l());
});

export function useRoute(): Route {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb); },
    () => current,
  );
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  const hash = `#${to.startsWith('/') ? to : `/${to}`}`;
  if (opts.replace) {
    history.replaceState(null, '', hash);
    current = readRoute();
    listeners.forEach(l => l());
  } else {
    window.location.hash = hash;
  }
}

/** Updates query params on the current route without adding history entries. */
export function setQuery(patch: Record<string, string | undefined>) {
  const q = new URLSearchParams(current.query);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === '' || v === 'all') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(`${current.path}${s ? `?${s}` : ''}`, { replace: true });
}

/* ---------- misc ---------- */

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useInterval(fn: () => void, ms: number) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const t = setInterval(() => ref.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function useKey(handler: (e: KeyboardEvent) => void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const on = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
}

export function useLocalStorage<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { return (localStorage.getItem(key) as T | null) ?? initial; } catch { return initial; }
  });
  const set = useCallback((next: T) => {
    setV(next);
    try { localStorage.setItem(key, next); } catch { /* storage unavailable */ }
  }, [key]);
  return [v, set];
}
