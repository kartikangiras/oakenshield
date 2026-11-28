import type { RuleId, Severity } from '../types.ts';

export interface RuleMeta {
  id: RuleId;
  title: string;
  defaultSeverity: Severity;
  category: 'conversions' | 'exposures' | 'sdk' | 'treatment' | 'identity' | 'audience' | 'hygiene';
  firesWhen: string;
  consequence: string;
  fix: string;
  /** True when the rule matches literals only; heuristic rules are never blocking by default. */
  deterministic: boolean;
}

export const RULES: RuleMeta[] = [
  {
    id: 'EG001',
    title: 'Conversion event removed or renamed',
    defaultSeverity: 'block',
    category: 'conversions',
    firesWhen: "A removed line held a running metric's event name and no added line in the PR restores it. The line can be a call site or a config file that declares the name.",
    consequence: 'That call site stops sending the conversion. If only one arm changed, that arm looks like it is losing.',
    fix: 'Restore the exact event name. Flagsmith matches event names exactly and drops unmatched ones silently.',
    deterministic: true,
  },
  {
    id: 'EG002',
    title: 'Experiment flag call removed',
    defaultSeverity: 'block',
    category: 'exposures',
    firesWhen: 'A removed line evaluated a running experiment flag and nothing in the PR evaluates it again. For a flag key kept in config and read through a variable: the line that declares it, or the last such read, was removed.',
    consequence: 'New users stop entering the experiment, or one arm stops getting new users.',
    fix: 'Restore the call, or end the experiment in Flagsmith before merging.',
    deterministic: true,
  },
  {
    id: 'EG003',
    title: 'Events switched off',
    defaultSeverity: 'block',
    category: 'sdk',
    firesWhen: 'A Flagsmith client loses enableEvents: true / enable_events=True, or sets it to false.',
    consequence: 'Every exposure and conversion from this app stops.',
    fix: 'Keep events enabled wherever the SDK is initialised.',
    deterministic: true,
  },
  {
    id: 'EG004',
    title: 'SDK can no longer send events',
    defaultSeverity: 'block',
    category: 'sdk',
    firesWhen: 'A manifest drops a Flagsmith SDK below its event-capable version, or switches to the legacy flagsmith-nodejs package.',
    consequence: 'Older SDKs cannot send events, so exposures and conversions stop.',
    fix: 'Use at least JS 12.4.0, Node.js 9.1.0, Python 6.3.0, Go v5.3.0, Java 8.2.0 or Flutter 6.2.0.',
    deterministic: true,
  },
  {
    id: 'EG005',
    title: 'Variation key changed in code',
    defaultSeverity: 'block',
    category: 'treatment',
    firesWhen: 'A comparison against a running variation key is removed or changed, or compares against a key the flag does not have.',
    consequence: 'Users bucketed into that variation see control code but are still counted in the variation.',
    fix: 'Compare against the exact variation key defined in Flagsmith.',
    deterministic: true,
  },
  {
    id: 'EG006',
    title: "One arm's code changed mid-run",
    defaultSeverity: 'warn',
    category: 'treatment',
    firesWhen: 'A change lands inside a branch on a running flag, in a component rendered only from such a branch, or in a file listed under treatment_paths for that flag.',
    consequence: 'Results now mix two versions of that arm, so the interval describes neither.',
    fix: 'Hold the PR until the experiment ends, or end it and start a new one after merging.',
    deterministic: false,
  },
  {
    id: 'EG007',
    title: 'Identity logic changed',
    defaultSeverity: 'warn',
    category: 'identity',
    firesWhen: 'A change touches identify(), the provider identity, an identifier argument, or the visitor-id code.',
    consequence: 'Exposures and conversions may stop matching, and users may land in two arms and be quarantined.',
    fix: 'Keep the identifier stable for the whole experiment.',
    deterministic: false,
  },
  {
    id: 'EG008',
    title: 'Exposure moved',
    defaultSeverity: 'warn',
    category: 'exposures',
    firesWhen: 'An experiment flag call moves to another file or function, especially app init, a layout or middleware.',
    consequence: 'People who never see the change get counted as exposed, diluting the effect.',
    fix: 'Evaluate where the user sees the change, or call trackExposureEvent at display time.',
    deterministic: false,
  },
  {
    id: 'EG009',
    title: 'Event name almost matches a metric',
    defaultSeverity: 'info',
    category: 'conversions',
    firesWhen: 'An added event name matches a running metric only when case or separators are ignored.',
    consequence: 'This event will not count toward the metric.',
    fix: "Use the metric's exact event name.",
    deterministic: true,
  },
  {
    id: 'EG010',
    title: 'Events never flushed',
    defaultSeverity: 'info',
    category: 'hygiene',
    firesWhen: 'A new script or serverless handler creates a Flagsmith client with events and never flushes.',
    consequence: 'Buffered events may be lost when the process exits.',
    fix: 'Call await flagsmith.close() or flushEvents() before exiting.',
    deterministic: false,
  },
  {
    id: 'EG011',
    title: 'Dynamic event or flag key',
    defaultSeverity: 'info',
    category: 'hygiene',
    firesWhen: 'An experiment call builds its event name or flag key dynamically.',
    consequence: 'Guard cannot verify this call.',
    fix: 'Use a string literal or a shared constant.',
    deterministic: true,
  },
  {
    id: 'EG012',
    title: 'Audience trait no longer sent',
    defaultSeverity: 'block',
    category: 'audience',
    firesWhen: "Code stops sending a trait that a running experiment's segment matches on, and nothing else in the repository still sends it.",
    consequence: "Users stop matching the experiment's audience: new users stop entering it, and people already in it can drop out mid-run.",
    fix: 'Keep sending the trait under the same key, or change the segment in Flagsmith once the experiment ends.',
    deterministic: true,
  },
  {
    id: 'EG013',
    title: 'Audience trait changed',
    defaultSeverity: 'warn',
    category: 'audience',
    firesWhen: "The value sent for a trait that a running experiment's segment matches on changes, or one of several places that send it stops.",
    consequence: "The segment matches a different group of people, so the experiment's population shifts mid-run.",
    fix: 'Ship the change after the experiment ends, or confirm with the experiment owner that the audience change is intended.',
    deterministic: false,
  },
];

export const RULES_BY_ID: Record<RuleId, RuleMeta> = Object.fromEntries(RULES.map(r => [r.id, r])) as Record<RuleId, RuleMeta>;
