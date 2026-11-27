/*
 * The dashboard's own experiments, run with Flagsmith Experimentation: the demo_start A/B test
 * and the first_screen duel (README, "The duel").
 *
 * Off unless the server is started with DASHBOARD_FLAGSMITH_ENVIRONMENT: then nothing is loaded
 * and every visitor sees the control version. When it is on:
 *   - each browser gets one anonymous ID, kept in localStorage, so a visitor always lands in the
 *     same version and their later actions are tied to the version they saw;
 *   - the Flagsmith JS SDK (12.4.0 or later) is initialised for that identity with events enabled;
 *   - useExperiment() records the exposure, trackEvent() records a conversion.
 * The two hooks are named after the SDK's own so that Experiment Guard's scanner recognises the
 * call sites (the flag key and event names) and protects them in this repo's pull requests.
 */
import { useEffect, useState } from 'react';
import { api } from './api.ts';

interface Flag { enabled: boolean; value: unknown; variant?: string }
interface Sdk {
  getExperimentFlag(name: string): Flag | null;
  trackEvent(event: string): void;
  flushEvents(): Promise<void>;
}

const VISITOR_KEY = 'oak-visitor';
/** How long the first screen waits for Flagsmith before showing the control version. */
const ASSIGN_TIMEOUT_MS = 2500;

let memoryId: string | undefined;
/** One anonymous ID per browser. If storage is unavailable it lasts for this page load only. */
export function visitorId(): string {
  try {
    const saved = localStorage.getItem(VISITOR_KEY);
    if (saved) return saved;
    const id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return (memoryId ??= crypto.randomUUID());
  }
}

let started: Promise<Sdk | null> | undefined;
/** Loads and initialises the SDK once. Resolves to null when the test is off or Flagsmith fails. */
export function startExperiments(): Promise<Sdk | null> {
  started ??= (async () => {
    try {
      const cfg = (await api.clientConfig()).experiments;
      if (!cfg) return null;
      const { default: flagsmith } = await import('@flagsmith/flagsmith');
      await flagsmith.init({
        environmentID: cfg.environmentKey,
        identity: visitorId(),
        enableEvents: true,
        // Self-hosted Flagsmith: http://localhost:8000/api/v1/ and http://localhost:8000/api/
        ...(cfg.apiUrl ? { api: cfg.apiUrl } : {}),
        ...(cfg.eventsApiUrl ? { eventProcessorConfig: { eventsApiUrl: cfg.eventsApiUrl } } : {}),
        // The SDK's own transport is XMLHttpRequest, which the browser cancels when the page
        // unloads. With keepalive, the last batch of events outlives the page.
        fetch: (url: RequestInfo, init?: RequestInit) => fetch(url, { ...init, keepalive: true }),
      });
      // Events are sent in batches; send what is buffered when the tab is hidden, reloaded or closed.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flagsmith.flushEvents();
      });
      window.addEventListener('pagehide', () => void flagsmith.flushEvents());
      return flagsmith as unknown as Sdk;
    } catch (err) {
      console.warn('[experiments] Flagsmith is unavailable, so the control version is shown.', err);
      return null;
    }
  })();
  return started;
}

const timeout = <T,>(p: Promise<T>, ms: number, fallback: T) =>
  Promise.race([p, new Promise<T>(r => setTimeout(() => r(fallback), ms))]);

// One assignment per flag per page load, so remounts (and React's strict mode) record one exposure.
const assignments = new Map<string, Promise<Served>>();

interface Served {
  /** The variation key, or null for the control version (also when the test is off). */
  variant: string | null;
  /** What the flag serves this visitor, when it is on. A duel keeps each version's screen here. */
  value: unknown;
}
const CONTROL: Served = { variant: null, value: null };

export interface Assignment extends Served {
  /** False while waiting for Flagsmith; render a placeholder rather than flash the wrong version. */
  ready: boolean;
}

/**
 * The visitor's version of an experiment. Reading the flag through getExperimentFlag records the
 * exposure, and Flagsmith only records it for identities enrolled in the running experiment.
 * Pass enroll: false to show the control version without entering the visitor in the test.
 */
export function useExperiment(flag: string, opts: { enroll?: boolean } = {}): Assignment {
  const enroll = opts.enroll ?? true;
  const [state, setState] = useState<Assignment>({ ready: !enroll, ...CONTROL });
  useEffect(() => {
    if (!enroll) { setState({ ready: true, ...CONTROL }); return; }
    let live = true;
    let assignment = assignments.get(flag);
    if (!assignment) {
      assignment = timeout(startExperiments(), ASSIGN_TIMEOUT_MS, null).then(sdk => {
        const f = sdk?.getExperimentFlag(flag);
        if (!f?.enabled) return CONTROL;
        return { variant: f.variant && f.variant !== 'control' ? f.variant : null, value: f.value };
      });
      assignments.set(flag, assignment);
    }
    void assignment.then(served => { if (live) setState({ ready: true, ...served }); });
    return () => { live = false; };
  }, [flag, enroll]);
  return state;
}

/** Records a conversion event for this visitor. Does nothing when the test is off. */
export function trackEvent(event: string): void {
  void startExperiments().then(sdk => sdk?.trackEvent(event));
}
