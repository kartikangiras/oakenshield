import type {
  ActivityItem, CheckRecord, CheckSummary, ClientConfig, DuelView, ExperimentView, FlagsmithAlert, Health, Overview, RuleId, RuleView,
  ScenarioView, SeveritySetting, Verdict,
} from '../../../server/src/api-types.ts';

export type * from '../../../server/src/api-types.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the Oakenshield server. Is it running?');
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export type SimulateKind = 'start-experiment' | 'change-weights' | 'edit-segment' | 'reset';

export interface CheckQuery {
  verdict?: Verdict | 'all';
  repo?: string;
  q?: string;
  rule?: string;
  limit?: number;
  offset?: number;
}

export interface CheckPage {
  total: number;
  items: CheckSummary[];
  repos: string[];
}

export type ExperimentDetail = ExperimentView & { recentChecks: CheckSummary[] };

const qs = (params: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== 'all') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const api = {
  health: () => request<Health>('GET', '/api/health'),
  clientConfig: () => request<ClientConfig>('GET', '/api/client-config'),
  duel: () => request<DuelView | null>('GET', '/api/duel'),
  overview: (days: number) => request<Overview>('GET', `/api/overview?days=${days}`),
  experiments: () => request<ExperimentView[]>('GET', '/api/experiments'),
  experiment: (id: string | number) => request<ExperimentDetail>('GET', `/api/experiments/${encodeURIComponent(String(id))}`),
  refreshExperiments: () => request<Health['flagsmith']>('POST', '/api/experiments/refresh', {}),
  checks: (q: CheckQuery) => request<CheckPage>('GET', `/api/checks${qs({ ...q })}`),
  check: (id: string) => request<CheckRecord>('GET', `/api/checks/${encodeURIComponent(id)}`),
  runScenario: (scenarioId: string) => request<CheckRecord>('POST', '/api/checks', { scenarioId }),
  runDiff: (diff: string, title?: string) => request<CheckRecord>('POST', '/api/checks', { diff, title }),
  rules: () => request<RuleView[]>('GET', '/api/rules'),
  setRule: (id: RuleId, severity: SeveritySetting) => request<RuleView>('PUT', `/api/rules/${id}`, { severity }),
  scenarios: () => request<ScenarioView[]>('GET', '/api/scenarios'),
  activity: () => request<ActivityItem[]>('GET', '/api/activity'),
  alerts: (experiment?: string | number) => request<FlagsmithAlert[]>('GET', `/api/alerts${qs({ experiment: experiment === undefined ? undefined : String(experiment), limit: 50 })}`),
  simulate: (kind: SimulateKind) => request<{ ok: true; alerts?: FlagsmithAlert[]; rechecked?: number; changed?: CheckSummary[] }>('POST', '/api/flagsmith/simulate', { kind }),
};
