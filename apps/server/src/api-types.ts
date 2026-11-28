// Types shared by the server's JSON API and the dashboard (imported as types only).
import type {
  ExperimentStatus, Finding, LiveExperiment, OverrideInfo, PullRequestInfo, Report, RuleId,
  Severity, SeveritySetting, SnapshotSource, Verdict,
} from '@oakenshield/guard/types';

export type { ExperimentStatus, Finding, LiveExperiment, OverrideInfo, PullRequestInfo, Report, RuleId, Severity, SeveritySetting, SnapshotSource, Verdict };

export type CheckSource = NonNullable<Report['source']>;

export interface CheckRecord {
  id: string;
  repo: string;
  pr?: PullRequestInfo;
  source: CheckSource;
  createdAt: string;
  durationMs: number;
  verdict: Verdict;
  counts: Report['counts'];
  stats: Report['stats'];
  affected: Report['affectedExperiments'];
  findings: Finding[];
  override?: OverrideInfo;
  scenarioId?: string;
  markdown: string;
  diff?: string;
}

export type CheckSummary = Omit<CheckRecord, 'findings' | 'markdown' | 'diff'> & {
  rules: RuleId[];
  findingsCount: number;
};

export interface CodeReference {
  path: string;
  line: number;
  text: string;
  kind: 'exposure' | 'conversion' | 'variant' | 'reference';
}

export interface ExperimentView extends LiveExperiment {
  references: CodeReference[];
  checks: number;
  blocks: number;
  warns: number;
  lastCheck?: { id: string; at: string; verdict: Verdict; pr?: PullRequestInfo };
}

export interface ActivityItem {
  id: string;
  at: string;
  kind: 'check' | 'override' | 'snapshot';
  verdict?: Verdict;
  repo?: string;
  title: string;
  detail: string;
  checkId?: string;
}

export interface DayPoint {
  date: string; // YYYY-MM-DD
  pass: number;
  warn: number;
  block: number;
  overridden: number;
}

export interface Overview {
  mode: 'demo' | 'live';
  rangeDays: number;
  kpis: {
    checks: number;
    checksPrev: number;
    blocks: number;
    blocksPrev: number;
    warns: number;
    overrides: number;
    passRate: number;
    protectedExperiments: number;
    runningExperiments: number;
    hoursSaved: number;
    medianDurationMs: number;
  };
  series: DayPoint[];
  byRule: Array<{ rule: RuleId; title: string; severity: Severity; count: number }>;
  byRepo: Array<{ repo: string; checks: number; blocks: number }>;
  recent: ActivityItem[];
}

export interface RuleView {
  id: RuleId;
  title: string;
  category: string;
  defaultSeverity: Severity;
  severity: SeveritySetting;
  firesWhen: string;
  consequence: string;
  fix: string;
  deterministic: boolean;
  hits30d: number;
}

export interface ScenarioView {
  id: string;
  title: string;
  description: string;
  author?: string;
  negative: boolean;
  expect: { verdict: Verdict; rules: RuleId[] };
  diff: string;
}

export interface Settings {
  hoursPerBlock: number;
  ruleSeverity: Partial<Record<RuleId, SeveritySetting>>;
}

/** Something that happened in Flagsmith that matters to a running experiment, or a re-check it caused. */
export interface FlagsmithAlert {
  id: string;
  at: string;
  kind: 'config-change' | 'segment-change' | 'flag-deleted' | 'experiment-started' | 'experiment-ended' | 'recheck';
  severity: 'block' | 'warn' | 'info';
  title: string;
  detail: string;
  experimentId?: number | string;
  experimentName?: string;
  flagKey?: string;
  actor?: string;
  /** 'webhook' for a real Flagsmith delivery, 'simulated' for the demo buttons. */
  origin: 'webhook' | 'simulated';
  eventType?: string;
  /** Checks created by a re-check, newest verdicts. */
  checkIds?: string[];
}

/** Public settings the dashboard reads at start-up. */
export interface ClientConfig {
  /**
   * The Flagsmith environment the dashboard's own A/B test runs in (docs/experiment.md). These
   * are client-side values: the environment key is public, like any web SDK key.
   */
  experiments: { environmentKey: string; apiUrl?: string; eventsApiUrl?: string } | null;
}

/**
 * The agent duel (README, "The duel"), as its files are on disk. The server passes them through
 * unread: the shapes belong to the duel package (record) and the flagsmith-duel skill (the rest).
 */
export interface DuelView {
  record: unknown;
  seal: unknown;
  verdict: unknown;
  approvals: unknown;
  /** The simulated visitors' run summary, when one has been written. */
  traffic: unknown;
  /** The same run as one character per counted visitor, in the order the visits finished. */
  replay: unknown;
}

/**
 * The trading arena. Like the duel, the server passes its parts on unread: the record belongs to
 * the arena package, the seal, verdict and approvals to the flagsmith-duel skill, and the state
 * (totals, the feed of paper trades, one character per settled market) to the arena's runner.
 */
export interface ArenaView {
  record: unknown;
  seal: unknown;
  verdict: unknown;
  approvals: unknown;
  state: unknown;
  /** The arena's own reading of its trade log, grouped by five minute window. Null until the result has been read. */
  check: unknown;
  /** The operator's loss limit from the brief: paper dollars lost over the last `over` settled markets. Null when the brief sets none. */
  limit: { max_loss: number; over: number } | null;
  /** When the runner last sent its state to this server. Null when it never has since the server started. */
  heard_at: string | null;
}

export interface Health {
  ok: true;
  version: string;
  mode: 'demo' | 'live';
  startedAt: string;
  flagsmith: { source: SnapshotSource | 'error'; fetchedAt?: string; environment?: string; running: number; error?: string };
  ingestProtected: boolean;
  webhooks: { secretSet: boolean; received: number; lastAt?: string; github: boolean };
}

export type StreamEvent =
  | { type: 'hello'; at: string }
  | { type: 'check'; check: CheckSummary }
  | { type: 'snapshot'; at: string; running: number }
  | { type: 'settings'; settings: Settings }
  | { type: 'alert'; alert: FlagsmithAlert };
