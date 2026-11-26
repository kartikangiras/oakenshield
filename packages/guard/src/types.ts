// Shared types for Experiment Guard.

export type RuleId =
  | 'EG001' | 'EG002' | 'EG003' | 'EG004' | 'EG005' | 'EG006'
  | 'EG007' | 'EG008' | 'EG009' | 'EG010' | 'EG011' | 'EG012' | 'EG013';

export type Severity = 'block' | 'warn' | 'info';
export type SeveritySetting = Severity | 'off';
export type Verdict = 'pass' | 'warn' | 'block' | 'overridden';
export type Lang = 'js' | 'py' | 'other';

export type ExperimentStatus = 'running' | 'draft' | 'paused' | 'ended';

export interface ArmStats {
  key: string;            // 'control' or a variation key
  identities: number;     // exposed identities
  conversions?: Record<string, number>; // metric event -> converting identities
}

export interface ExperimentHealth {
  srmWarning?: boolean;
  quarantined?: number;
  lastComputedAt?: string;
}

export interface AudienceSegment {
  id: number | string;
  name: string;
  /** Trait keys used in the segment's rules (condition properties). */
  traits: string[];
}

export interface LiveExperiment {
  id: number | string;
  name: string;
  environmentKey: string;
  flagKey: string;
  featureId?: number;
  controlValue?: string;
  variationKeys: string[];   // keyed variations, never including 'control'
  metricEvents: string[];    // definition.event of each attached metric
  status: ExperimentStatus;
  startedAt?: string;
  endsAt?: string;
  hypothesis?: string;
  dashboardUrl?: string;
  repo?: string;             // optional: which repo the experiment lives in (dashboard use)
  arms?: ArmStats[];
  health?: ExperimentHealth;
  /** Segments that decide who can enter the experiment, with the traits their rules match on. */
  audience?: AudienceSegment[];
}

export type SnapshotSource = 'flagsmith-api' | 'flagsmith-cli' | 'file' | 'demo';

export interface Snapshot {
  fetchedAt: string;
  source: SnapshotSource;
  environmentKey?: string;
  experiments: LiveExperiment[];
}

// ---- diffs ----

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  header?: string;
  lines: DiffLine[];
}

export interface FileDiff {
  oldPath: string | null;
  newPath: string | null;
  /** The path to report: newPath, or oldPath for deletions. */
  path: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  binary: boolean;
  hunks: Hunk[];
}

// ---- scanning ----

export type HitKind =
  | 'exposure'     // getExperimentFlag / useExperiment / trackExposureEvent / get_experiment_flag
  | 'conversion'   // trackEvent / track_event
  | 'variant'      // comparison against a variation key
  | 'events'       // enableEvents: true|false / enable_events=True|False
  | 'identity'     // identify(), identity:, identifier=
  | 'init'         // a Flagsmith client is created
  | 'dynamic'      // an experiment call whose key is not a literal
  | 'literal';     // any quoted string

export interface Hit {
  kind: HitKind;
  value: string;
}

export interface ScannedLine {
  file: string;
  line: number;
  text: string;
  side: 'added' | 'removed' | 'head';
  lang: Lang;
  hits: Hit[];
  literals: Set<string>;
}

// ---- findings and reports ----

export interface Suggestion {
  file: string;
  line: number;          // line in the head (new) version of the file
  original: string;
  replacement: string;
}

export interface Finding {
  id: string;
  rule: RuleId;
  severity: Severity;
  title: string;
  experimentId: number | string | null;
  experimentName: string | null;
  flagKey: string | null;
  file: string;
  line: number;
  side: 'added' | 'removed' | 'head';
  evidence: string;
  consequence: string;
  hint?: string;
  suggestion?: Suggestion;
  ignoredBecause?: string;
  aiNote?: string;
}

export interface OverrideInfo {
  by: string;
  at: string;
  label: string;
  accepted: boolean;
  reason?: string;
}

export interface PullRequestInfo {
  number: number;
  /** Head commit, so a later re-check can set a commit status on it. */
  headSha?: string;
  title?: string;
  author?: string;
  branch?: string;
  url?: string;
}

export interface Report {
  version: 1;
  tool: 'experiment-guard';
  toolVersion: string;
  createdAt: string;
  durationMs: number;
  repo?: string;
  base?: string;
  head?: string;
  pr?: PullRequestInfo;
  source?: 'ci' | 'cli' | 'mcp' | 'playground' | 'api' | 'webhook';
  /** The unified diff that was checked. Sent along with --report-url so a dashboard can re-check it later. */
  diff?: string;
  snapshot: { fetchedAt: string; source: SnapshotSource; running: number };
  stats: { filesChanged: number; linesAdded: number; linesRemoved: number; filesScanned: number };
  findings: Finding[];
  counts: { block: number; warn: number; info: number; ignored: number };
  verdict: Verdict;
  override?: OverrideInfo;
  affectedExperiments: Array<{ id: number | string; name: string; flagKey: string }>;
}
