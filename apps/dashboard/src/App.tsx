import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent } from 'react';
import { Icon, Logo } from './components/Icons.tsx';
import type { IconName } from './components/Icons.tsx';
import { AlertRow } from './components/alerts.tsx';
import { HeroSlotProvider, Kbd, VerdictChip, cx, useToast } from './components/ui.tsx';
import { api } from './lib/api.ts';
import type { CheckSummary, ExperimentView, RuleView, ScenarioView, Verdict } from './lib/api.ts';
import { parseScreen } from '../../../packages/duel/src/screen.ts';
import { useExperiment } from './lib/experiments.ts';
import { navigate, useKey, useLocalStorage, useRoute } from './lib/hooks.ts';
import { useLive } from './lib/live.tsx';
import { CheckDetailPage } from './pages/CheckDetail.tsx';
import { ChecksPage } from './pages/Checks.tsx';
import { ExperimentsPage } from './pages/Experiments.tsx';
import { DuelPage } from './pages/Duel.tsx';
import { FirstScreen } from './pages/FirstScreen.tsx';
import { IntegrationsPage } from './pages/Integrations.tsx';
import { OverviewPage } from './pages/Overview.tsx';
import { PlaygroundPage } from './pages/Playground.tsx';
import { RulesPage } from './pages/Rules.tsx';

const NAV: Array<{ path: string; label: string; icon: IconName }> = [
  { path: '/', label: 'Overview', icon: 'grid' },
  { path: '/duel', label: 'Duel', icon: 'swap' },
  { path: '/experiments', label: 'Experiments', icon: 'flask' },
  { path: '/checks', label: 'Checks', icon: 'pr' },
  { path: '/playground', label: 'Playground', icon: 'play' },
  { path: '/rules', label: 'Rules', icon: 'sliders' },
  { path: '/integrations', label: 'Set up', icon: 'plug' },
];

export type Theme = 'dark' | 'light';

/** The current top-level page, read at call time (the redirect below must not act on a stale route). */
const readTop = () => window.location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';

export function App() {
  const route = useRoute();
  const [theme, setTheme] = useLocalStorage<Theme>('oak-theme', (document.documentElement.dataset.theme as Theme) ?? 'light');
  const [palette, setPalette] = useState(false);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);

  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useKey(e => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette(p => !p); }
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '/') { e.preventDefault(); setPalette(true); }
  });

  const top = route.parts[0] ?? '';
  const active = `/${top}`;

  // A/B test (README): what the demo opens on. Control shows the overview; the try_it
  // arm opens the guided Playground with one broken pull request. Only visitors who arrive on the
  // home page are entered; a link to any other page is honoured and not part of the test.
  const [landedHome] = useState(() => top === '');
  // The duel (README, "The duel"): the first screen is whatever the first_screen flag serves.
  // While a duel runs, each agent's version is the value of its variation; afterwards the flag
  // serves the winner to everyone. Its control value is not a screen, and then demo_start decides.
  const duel = useExperiment('first_screen', { enroll: landedHome });
  const screen = useMemo(() => parseScreen(duel.value), [duel.value]);
  const start = useExperiment('demo_start', { enroll: landedHome && duel.ready && !screen });
  const redirected = useRef(false);
  useEffect(() => {
    if (start.variant === 'try_it' && !redirected.current && (readTop() === '')) {
      redirected.current = true;
      navigate('/playground?guided=1', { replace: true });
    }
  }, [start.variant]);

  let page;
  switch (top) {
    // Wait for the assignment (at most a moment) so try_it visitors never see the overview first.
    case '': page = !duel.ready ? null : screen ? <FirstScreen screen={screen} /> : start.ready ? <OverviewPage /> : null; break;
    case 'experiments': page = <ExperimentsPage selected={route.parts[1]} />; break;
    case 'checks': page = route.parts[1] ? <CheckDetailPage id={route.parts[1]} /> : <ChecksPage />; break;
    case 'playground': page = <PlaygroundPage />; break;
    case 'duel': page = <DuelPage />; break;
    case 'rules': page = <RulesPage focus={route.query.get('focus') ?? undefined} />; break;
    case 'integrations': page = <IntegrationsPage theme={theme} setTheme={setTheme} />; break;
    default: page = <div className="card"><div className="empty"><b>Page not found</b><a className="link" href="#/">Back to overview</a></div></div>;
  }

  const skip = (e: MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); document.getElementById('main')?.focus(); };

  return (
    <div className="app">
      {/* Routes live in the hash, so the skip link moves focus itself. */}
      <a className="skip" href="#main" onClick={skip}>Skip to content</a>
      <header className="topbar">
        <a className="brand" href="#/" aria-label="Oakenshield, overview">
          <Logo size={24} />
          <span>Oakenshield</span>
        </a>
        <NavLinks active={active} />
        <div className="topbar-right">
          <Status />
          <button className="round" title="Search (⌘K)" aria-label="Search" onClick={() => setPalette(true)}><Icon name="search" size={18} /></button>
          <button className="round" title={`Switch to the ${theme === 'dark' ? 'light' : 'dark'} theme`} aria-label="Switch theme" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
          </button>
          <Bell />
        </div>
      </header>
      <div className="page-slot" ref={setSlot} />
      <HeroSlotProvider value={slot}>
        <main id="main" tabIndex={-1} className="content" key={top}>{page}</main>
      </HeroSlotProvider>
      {palette && <CommandPalette onClose={() => setPalette(false)} toggleTheme={() => setTheme(theme === 'dark' ? 'light' : 'dark')} />}
    </div>
  );
}

function NavLinks({ active }: { active: string }) {
  return (
    <nav className="nav" aria-label="Main">
      {NAV.map(n => (
        <a key={n.path} href={`#${n.path}`} className={cx('nav-link', active === n.path && 'on')} aria-current={active === n.path ? 'page' : undefined}>
          {n.label}
        </a>
      ))}
    </nav>
  );
}

function Status() {
  const { connected, health, healthError } = useLive();
  const fs = health?.flagsmith;
  // The details (data source, environment, running experiments) stay in the tooltip.
  const detail = fs ? `${fs.source === 'demo' ? 'Demo data' : fs.source === 'error' ? 'Flagsmith error' : 'Flagsmith'}${fs.environment ? ` · ${fs.environment}` : ''} · ${fs.running} running experiments` : '';
  const online = connected && !healthError && fs?.source !== 'error';
  return (
    <span className="status" title={[connected ? 'Receiving live events' : 'Reconnecting to the event stream', detail].filter(Boolean).join('\n')}>
      <span className={cx('pulse', !online && 'off')} />
      <b>{healthError ? 'Offline' : !health ? 'Connecting…' : online ? 'Online' : fs?.source === 'error' ? 'Flagsmith unreachable' : 'Reconnecting…'}</b>
    </span>
  );
}

function Bell() {
  const { alerts, unread, markRead } = useLive();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: globalThis.MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  useKey(e => { if (open && e.key === 'Escape') setOpen(false); });
  const toggle = () => { if (!open) markRead(); setOpen(o => !o); };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="round" title={unread ? `${unread} new Flagsmith alert${unread === 1 ? '' : 's'}` : 'Flagsmith alerts'} aria-label="Flagsmith alerts" aria-expanded={open} onClick={toggle}>
        <Icon name="bell" size={18} />
        {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="popover" role="dialog" aria-label="Flagsmith alerts">
          <div className="row" style={{ justifyContent: 'space-between', padding: '16px 16px 12px' }}>
            <div>
              <div style={{ fontWeight: 600 }}>Flagsmith alerts</div>
              <div className="small faint">Changes to running experiments, and the pull requests they affect</div>
            </div>
          </div>
          <div style={{ maxHeight: 420, overflow: 'auto', borderTop: '1px solid var(--border)' }}>
            {alerts.length === 0 ? (
              <div className="empty small" style={{ padding: 24 }}>
                No alerts yet. Add the webhook in Flagsmith and changes to running experiments show up here.
              </div>
            ) : alerts.slice(0, 20).map(a => <AlertRow key={a.id} a={a} compact onOpen={() => setOpen(false)} />)}
          </div>
          <a className="row small" href="#/integrations" onClick={() => setOpen(false)} style={{ padding: '12px 16px', borderTop: '1px solid var(--border)', color: 'var(--brand-2)' }}>
            <Icon name="plug" size={14} />Set up Flagsmith webhooks
          </a>
        </div>
      )}
    </div>
  );
}

/* ---------- command palette ---------- */

interface Cmd { id: string; group: string; label: string; icon: IconName; hint?: string; keywords?: string; run: () => void }

function CommandPalette({ onClose, toggleTheme }: { onClose: () => void; toggleTheme: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [data, setData] = useState<{ exps: ExperimentView[]; rules: RuleView[]; checks: CheckSummary[]; scenarios: ScenarioView[] }>({ exps: [], rules: [], checks: [], scenarios: [] });
  const listRef = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const { refreshHealth } = useLive();

  useEffect(() => {
    Promise.allSettled([api.experiments(), api.rules(), api.checks({ limit: 12 }), api.scenarios()]).then(([e, r, c, s]) => {
      setData({
        exps: e.status === 'fulfilled' ? e.value : [],
        rules: r.status === 'fulfilled' ? r.value : [],
        checks: c.status === 'fulfilled' ? c.value.items : [],
        scenarios: s.status === 'fulfilled' ? s.value : [],
      });
    });
  }, []);

  const go = (path: string) => () => { navigate(path); onClose(); };
  const all: Cmd[] = useMemo(() => [
    ...NAV.map(n => ({ id: `nav${n.path}`, group: 'Go to', label: n.label, icon: n.icon, run: go(n.path) })),
    { id: 'act-run', group: 'Actions', label: 'Run a check in the playground', icon: 'play' as IconName, run: go('/playground') },
    { id: 'act-theme', group: 'Actions', label: 'Toggle light / dark theme', icon: 'sun' as IconName, run: () => { toggleTheme(); onClose(); } },
    {
      id: 'act-refresh', group: 'Actions', label: 'Refresh Flagsmith snapshot', icon: 'refresh' as IconName,
      run: () => {
        onClose();
        api.refreshExperiments().then(
          f => { refreshHealth(); toast({ kind: 'pass', title: 'Snapshot refreshed', body: `${f.running} running experiments` }); },
          (e: Error) => toast({ kind: 'block', title: 'Refresh failed', body: e.message }),
        );
      },
    },
    ...data.exps.map(e => ({ id: `exp${e.id}`, group: 'Experiments', label: e.name, icon: 'flask' as IconName, hint: e.flagKey, keywords: `${e.flagKey} ${e.metricEvents.join(' ')}`, run: go(`/experiments/${e.id}`) })),
    ...data.checks.map(c => ({ id: `chk${c.id}`, group: 'Recent checks', label: c.pr?.title ?? c.repo, icon: 'pr' as IconName, hint: `${c.repo}${c.pr?.number ? ` #${c.pr.number}` : ''}`, keywords: c.rules.join(' '), run: go(`/checks/${c.id}`) })),
    ...data.rules.map(r => ({ id: `rule${r.id}`, group: 'Rules', label: `${r.id} · ${r.title}`, icon: 'sliders' as IconName, hint: r.severity, run: go(`/rules?focus=${r.id}`) })),
    ...data.scenarios.map(s => ({ id: `scn${s.id}`, group: 'Playground scenarios', label: s.title, icon: 'play' as IconName, hint: s.expect.verdict, run: go(`/playground?scenario=${s.id}`) })),
  ], [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return all.filter(c => c.group !== 'Playground scenarios' && c.group !== 'Rules').slice(0, 30);
    const words = needle.split(/\s+/);
    return all.filter(c => {
      const hay = `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''} ${c.group}`.toLowerCase();
      return words.every(w => hay.includes(w));
    }).slice(0, 40);
  }, [q, all]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => Math.min(items.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => Math.max(0, s - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); items[sel]?.run(); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let lastGroup = '';
  return (
    <>
      <div className="overlay" style={{ zIndex: 60 }} onClick={onClose} />
      <div className="palette" role="dialog" aria-label="Command palette" onKeyDown={onKey}>
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: 16, top: 0, bottom: 0, display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}><Icon name="search" size={18} /></span>
          <input autoFocus className="palette-input" placeholder="Search pages, experiments, rules and checks" aria-label="Search" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="empty small">No matches for “{q}”.</div>}
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header}
                <div className={cx('palette-item', i === sel && 'on')} onMouseMove={() => setSel(i)} onClick={c.run}>
                  <Icon name={c.icon} size={16} />
                  <span>{c.label}</span>
                  {c.group === 'Playground scenarios' && c.hint ? <span className="hint"><VerdictChip verdict={c.hint as Verdict} compact /></span>
                    : c.hint && <span className="hint mono">{c.hint}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="row small faint" style={{ padding: '8px 16px', borderTop: '1px solid var(--border)', gap: 16 }}>
          <span className="row"><Kbd>↑</Kbd><Kbd>↓</Kbd>navigate</span>
          <span className="row"><Kbd>↵</Kbd>open</span>
          <span className="row"><Kbd>esc</Kbd>close</span>
        </div>
      </div>
    </>
  );
}
