import type { Snapshot } from './types.ts';

/**
 * The demo snapshot: one experiment in the bundled FirstPR demo app plus a few
 * from other repos, so the dashboard has something to show without Flagsmith.
 */
export function demoSnapshot(now = new Date()): Snapshot {
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();
  return {
    fetchedAt: now.toISOString(),
    source: 'demo',
    environmentKey: 'demo_prod',
    experiments: [
      {
        id: 101,
        name: 'Connect-first onboarding',
        environmentKey: 'demo_prod',
        flagKey: 'onboarding_flow',
        featureId: 9001,
        controlValue: 'value_first',
        variationKeys: ['github_first'],
        metricEvents: ['issue_opened', 'github_connected'],
        status: 'running',
        startedAt: daysAgo(3),
        endsAt: inDays(4),
        repo: 'oakenshield/firstpr',
        hypothesis: 'Asking for GitHub first raises github_connected and does not lower issue_opened.',
        audience: [{ id: 7001, name: 'First-time visitors', traits: ['visitor_type'] }],
        arms: [
          { key: 'control', identities: 412, conversions: { issue_opened: 141, github_connected: 52 } },
          { key: 'github_first', identities: 405, conversions: { issue_opened: 133, github_connected: 171 } },
        ],
        health: { srmWarning: false, quarantined: 3, lastComputedAt: daysAgo(0.02) },
      },
      {
        id: 102,
        name: 'Mentor matching quiz',
        environmentKey: 'demo_prod',
        flagKey: 'mentor_match',
        featureId: 9002,
        controlValue: 'directory',
        variationKeys: ['match_quiz'],
        metricEvents: ['mentor_requested'],
        status: 'running',
        startedAt: daysAgo(9),
        endsAt: inDays(5),
        repo: 'oakenshield/community',
        hypothesis: 'A three-question quiz finds a better mentor than browsing the directory, and lifts mentor_requested.',
        arms: [
          { key: 'control', identities: 2210, conversions: { mentor_requested: 287 } },
          { key: 'match_quiz', identities: 2187, conversions: { mentor_requested: 341 } },
        ],
        health: { srmWarning: false, quarantined: 11, lastComputedAt: daysAgo(0.04) },
      },
      {
        id: 103,
        name: 'Search ranking v2',
        environmentKey: 'demo_prod',
        flagKey: 'search_ranking',
        featureId: 9003,
        controlValue: 'bm25',
        variationKeys: ['semantic', 'hybrid'],
        metricEvents: ['result_clicked', 'search_refined'],
        status: 'running',
        startedAt: daysAgo(6),
        endsAt: inDays(8),
        repo: 'oakenshield/community',
        hypothesis: 'Semantic or hybrid ranking puts the right result higher, so people click more and refine less.',
        audience: [{ id: 7002, name: 'Signed-in members', traits: ['member_since'] }],
        arms: [
          { key: 'control', identities: 1630, conversions: { result_clicked: 702, search_refined: 410 } },
          { key: 'semantic', identities: 1588, conversions: { result_clicked: 731, search_refined: 362 } },
          { key: 'hybrid', identities: 1702, conversions: { result_clicked: 802, search_refined: 371 } },
        ],
        health: { srmWarning: true, quarantined: 46, lastComputedAt: daysAgo(0.03) },
      },
      {
        id: 104,
        name: 'Weekly digest prompt',
        environmentKey: 'demo_prod',
        flagKey: 'digest_prompt',
        featureId: 9004,
        controlValue: 'control',
        variationKeys: ['show-prompt'],
        metricEvents: ['digest_subscribed'],
        status: 'ended',
        startedAt: daysAgo(30),
        endsAt: daysAgo(12),
        repo: 'oakenshield/firstpr',
        hypothesis: 'Offering a weekly email of matched issues brings people back.',
        arms: [
          { key: 'control', identities: 5120, conversions: { digest_subscribed: 0 } },
          { key: 'show-prompt', identities: 5098, conversions: { digest_subscribed: 734 } },
        ],
        health: { srmWarning: false, quarantined: 8 },
      },
      {
        id: 105,
        name: 'Sticky docs sign-up CTA',
        environmentKey: 'demo_prod',
        flagKey: 'docs_cta',
        featureId: 9005,
        controlValue: 'inline',
        variationKeys: ['sticky'],
        metricEvents: ['signup_started'],
        status: 'draft',
        repo: 'oakenshield/docs-site',
        hypothesis: 'A sticky CTA in the docs sidebar starts more sign-ups.',
      },
    ],
  };
}
