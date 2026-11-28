/*
 * The desk: where the runner asks which version trades a market, and reports what happened.
 * The real one is Flagsmith, through its Node SDK. The market's name is the identity, so
 * Flagsmith does the randomisation, records the exposure and counts the outcomes; the runner
 * keeps no say in who trades what. The local one is for rehearsals and tests, and never touches
 * Flagsmith.
 */
import { createHash } from 'node:crypto';
import { Flagsmith } from '@flagsmith/nodejs';

export interface Seat {
  /** 'control' or the version's key. */
  arm: string;
  /** The flag's value for this market: the trader, as JSON. */
  value: unknown;
  /** False when the flag is off or missing. Nothing trades then: the flag is the kill switch. */
  enabled: boolean;
  /** Whether this market counts in a running experiment. */
  enrolled: boolean;
}

export interface Desk {
  seat(market: string): Promise<Seat>;
  event(name: string, market: string, value?: number): void;
  /** Sends what is waiting. It never fails; `acked` says what Flagsmith took. */
  flush(): Promise<void>;
  /** Whether Flagsmith has accepted this event for this market. */
  acked(name: string, market: string): boolean;
  /** Whether Flagsmith has accepted this market's exposure. Asking for its seat again sends a new one. */
  exposed(market: string): boolean;
  close(): Promise<void>;
}

export interface DeskConfig {
  environmentKey: string;
  flag: string;
  /** The planned value of every arm. Names the arm once the experiment is over and the flag serves one value to all. */
  values?: Record<string, string>;
  apiUrl?: string;
  eventsUrl?: string;
  /** Hears about every answer of the events API that is not a yes. */
  warn?: (line: string) => void;
}

const quiet = { debug() {}, info() {}, warn() {}, error() {}, fatal() {}, trace() {}, child() { return quiet; } };
const ackKey = (name: string, market: string) => `${name}|${market}`;

export function flagsmithDesk(c: DeskConfig): Desk {
  const took = new Set<string>();
  // The SDK sends events in batches and swallows failures by design. Watching its requests is how
  // the runner knows which outcomes Flagsmith really has, so that none is assumed and none is lost.
  const watched: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const res = await fetch(input, init);
    if (!url.endsWith('/v1/events')) return res;
    if (!res.ok) { c.warn?.(`Flagsmith's events API answered ${res.status}`); return res; }
    try {
      const { events } = JSON.parse(String(init?.body)) as { events: { event: string; identifier: string | null }[] };
      for (const e of events) if (e.identifier) took.add(ackKey(e.event, e.identifier));
    } catch { /* not a body this desk wrote */ }
    return res;
  };
  const client = new Flagsmith({
    environmentKey: c.environmentKey,
    ...(c.apiUrl ? { apiUrl: c.apiUrl } : {}),
    enableEvents: true,
    ...(c.eventsUrl ? { eventProcessorConfig: { eventsApiUrl: c.eventsUrl } } : {}),
    fetch: watched,
    // The runner reports its own failures; the SDK's logger would interleave JSON with the trade lines.
    logger: quiet as never,
  });
  return {
    async seat(market) {
      const flag = await client.getExperimentFlag(c.flag, market);
      const experiment = 'experiment' in flag ? flag.experiment : undefined;
      const variant = 'variant' in flag ? flag.variant : undefined;
      const enrolled = flag.enabled && experiment?.inExperiment === true;
      // The SDK records an exposure only when the flag carries a variant key. Control has to count too.
      if (enrolled && variant === undefined) client.trackExposureEvent(c.flag, { identifier: market, value: 'control', metadata: { experiment_id: experiment!.id } });
      const named = Object.entries(c.values ?? {}).find(([, v]) => v === flag.value)?.[0];
      return { arm: enrolled ? variant ?? 'control' : named ?? variant ?? 'control', value: flag.value, enabled: flag.enabled, enrolled };
    },
    event(name, market, value) { client.trackEvent(name, { identifier: market, ...(value === undefined ? {} : { value }) }); },
    flush: () => client.flushEvents(),
    acked: (name, market) => took.has(ackKey(name, market)),
    exposed: market => took.has(ackKey('$flag_exposure', market)),
    async close() { await client.flushEvents(); await client.close(); },
  };
}

export interface LocalPlan { control: string; versions: Record<string, { value: unknown }>; split: Record<string, number> }

/** The same split without Flagsmith: a market's bucket is a hash of its name. For rehearsals and tests. */
export function localDesk(plan: LocalPlan, events: { name: string; market: string; value?: number }[] = []): Desk {
  const arms = Object.entries(plan.split);
  const whole = arms.reduce((n, [, share]) => n + share, 0);
  const took = new Set<string>();
  return {
    async seat(market) {
      let at = (createHash('sha256').update(market).digest().readUInt32BE(0) / 2 ** 32) * whole;
      const arm = (arms.find(([, share]) => (at -= share) < 0) ?? arms[0]!)[0];
      const value = arm === 'control' ? plan.control : plan.versions[arm]?.value;
      return { arm, value, enabled: true, enrolled: true };
    },
    event(name, market, value) { events.push({ name, market, ...(value === undefined ? {} : { value }) }); took.add(ackKey(name, market)); },
    async flush() {},
    acked: (name, market) => took.has(ackKey(name, market)),
    exposed: () => true,
    async close() {},
  };
}
