import { useState } from 'react';
import { DEFAULT_SCENARIO, scenarioOf } from '../../../../packages/duel/src/screen.ts';
import type { Block, LinkTarget, Screen } from '../../../../packages/duel/src/screen.ts';
import { Icon } from '../components/Icons.tsx';
import { DiffView } from '../components/report.tsx';
import { Empty, PageHead, Skeleton, cx } from '../components/ui.tsx';
import { api } from '../lib/api.ts';
import type { CheckRecord } from '../lib/api.ts';
import { trackEvent } from '../lib/experiments.ts';
import { navigate, useAsync } from '../lib/hooks.ts';
import { Result, RunButton } from './Playground.tsx';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const LINKS: Record<LinkTarget, string> = { playground: '/playground', experiments: '/experiments', setup: '/integrations', rules: '/rules' };

/**
 * A first screen served by the first_screen flag (packages/duel/src/screen.ts). In a duel each
 * agent's version is one of these. Whatever the blocks say, the action is the same: the run
 * block checks one seeded pull request and sends check_run, the event the duel counts.
 * With preview set (the Duel page) nothing is sent to Flagsmith.
 */
export function FirstScreen({ screen, preview = false }: { screen: Screen; preview?: boolean }) {
  const scenarios = useAsync(() => api.scenarios(), []);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CheckRecord>();
  const [error, setError] = useState<string>();

  const list = scenarios.data ?? [];
  const find = (id: string) => list.find(s => s.id === id) ?? list.find(s => s.id === DEFAULT_SCENARIO) ?? list[0];
  const target = find(scenarioOf(screen));

  const run = async () => {
    if (!target) return;
    if (!preview) trackEvent('check_run');
    setRunning(true);
    setError(undefined);
    setResult(undefined);
    try {
      const [r] = await Promise.all([api.runScenario(target.id), sleep(650)]);
      setResult(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const [first, ...rest] = screen.blocks;
  const titled = first?.type === 'heading';
  const body = titled ? rest : screen.blocks;

  const render = (b: Block, i: number) => {
    switch (b.type) {
      case 'heading': return <h2 key={i} className="screen-h">{b.text}</h2>;
      case 'text': return <p key={i} className="screen-p">{b.text}</p>;
      case 'steps': return <ol key={i} className="steps screen-steps">{b.items.map((s, n) => <li key={n}><b>{s}</b></li>)}</ol>;
      case 'pull_request': {
        const s = find(b.scenario);
        if (!s) return <Skeleton key={i} h={200} />;
        return (
          <div key={i} className="screen-pr">
            <div className="row small" style={{ gap: 8, marginBottom: 8 }}>
              <Icon name="pr" size={14} /><b>{s.title}</b>
              {s.author && <span className="faint">a pull request by @{s.author}</span>}
            </div>
            <div className={cx(running && 'scan')} style={{ borderRadius: 12 }}>
              <DiffView diff={s.diff} findings={result?.findings} />
            </div>
            {b.caption && <div className="small muted" style={{ marginTop: 8 }}>{b.caption}</div>}
          </div>
        );
      }
      case 'run': return <div key={i}><RunButton running={running} onClick={run} disabled={!target} label={b.label} /></div>;
      case 'link': return (
        <div key={i}>
          <button type="button" className="btn ghost sm" onClick={() => navigate(LINKS[b.to])}>{b.label}<Icon name="chevronRight" size={13} /></button>
        </div>
      );
    }
  };

  return (
    <div className="fade-in">
      {!preview && <PageHead title={titled ? first.text : 'Experiment Guard'} />}
      <div className="stack screen">
        <div className="card screen-card">
          {preview && titled && <h2 className="screen-h">{first.text}</h2>}
          {body.map(render)}
        </div>
        {scenarios.error && <div className="card"><Empty icon="alert" title="The demo pull requests did not load">{scenarios.error.message}</Empty></div>}
        {error && <div className="card fade-in"><Empty icon="alert" title="The check did not run">{error}</Empty></div>}
        {result && <Result r={result} expected={target} />}
      </div>
    </div>
  );
}
