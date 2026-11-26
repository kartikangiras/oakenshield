import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfigText } from '../src/config.ts';
import { demoSnapshot } from '../src/demo.ts';
import { runCheck } from '../src/engine.ts';
import { unenforcedNote, withNote, type GitHubContext } from '../src/github.ts';
import { DiffOnlyRepoView, MemoryRepoView } from '../src/repo.ts';
import { renderMarkdown, renderText } from '../src/report.ts';
import { aliasOf, aliasUses, branchesOn, regionEnd } from '../src/rules/treatment.ts';
import type { Snapshot } from '../src/types.ts';

// A payment approval experiment shaped like a real integration: the variation is stored in a
// boolean, and the arm is rendered further down, wherever that boolean is tested.
const payments: Snapshot = {
  fetchedAt: '2026-11-26T12:00:00.000Z',
  source: 'file',
  environmentKey: 'test',
  experiments: [{
    id: 687,
    name: 'Payment amount display',
    environmentKey: 'test',
    flagKey: 'payment_amount_display',
    controlValue: 'sol_only',
    variationKeys: ['show_usd'],
    metricEvents: ['payment_approved', 'payment_rejected'],
    metrics: [
      { event: 'payment_approved', expectedDirection: 'increase' },
      { event: 'payment_rejected', expectedDirection: 'not_increase' },
    ],
    status: 'running',
  }],
};

const MODAL = [
  "import { useExperiment } from '@/lib/experiments';",                 // 1
  '',                                                                   // 2
  'export function PaymentModal({ payment }) {',                        // 3
  "  const amountDisplay = useExperiment('payment_amount_display');",   // 4
  "  const showUsd = amountDisplay.variant === 'show_usd';",            // 5
  '  const solUsd = useSolUsdPrice(showUsd);',                          // 6
  '',                                                                   // 7
  '  if (payment.status === "submitted") {',                            // 8
  '    return <p>Payment submitted</p>;',                               // 9
  '  }',                                                                // 10
  '',                                                                   // 11
  '  return (',                                                         // 12
  '    <div>',                                                          // 13
  '      <span>{formatAmount(payment.challenge)}</span>',               // 14
  '      {showUsd && solUsd !== null && (',                             // 15
  '        <span className="usd">≈ {formatUsd(amount * solUsd)}</span>', // 16
  '      )}',                                                           // 17
  '      <button>Sign and pay</button>',                                // 18
  '    </div>',                                                         // 19
  '  );',                                                               // 20
  '}',                                                                  // 21
  '',
].join('\n');

const EVENTS = [
  "import { trackEvent } from '@/lib/experiments';",
  'export function approve() {',
  "  trackEvent('payment_approved');",
  '}',
  'export function reject() {',
  "  trackEvent('payment_rejected');",
  '}',
  '',
].join('\n');

const wired = { 'client/PaymentModal.tsx': MODAL, 'client/payments.ts': EVENTS };
const rulesOf = (r: { findings: Array<{ rule: string }> }) => r.findings.map(f => f.rule);

describe('EG006 finds the arm, not the assignment', () => {
  it('ignores code that merely follows a stored variant comparison', () => {
    const head = { ...wired, 'client/PaymentModal.tsx': MODAL.replace('Payment submitted', 'Payment sent') };
    const report = runCheck({ repo: new MemoryRepoView(wired, head), snapshot: payments });
    assert.deepEqual(report.findings, []);
  });

  it('flags a change where the stored comparison is tested', () => {
    const head = { ...wired, 'client/PaymentModal.tsx': MODAL.replace('className="usd"', 'className="usd muted"') };
    const report = runCheck({ repo: new MemoryRepoView(wired, head), snapshot: payments });
    assert.deepEqual(rulesOf(report), ['EG006']);
    assert.equal(report.findings[0].line, 16);
    assert.match(report.findings[0].consequence, /inside the 'show_usd' branch/);
  });

  it('stays quiet about code after the arm closes', () => {
    const head = { ...wired, 'client/PaymentModal.tsx': MODAL.replace('Sign and pay', 'Sign & pay') };
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(wired, head), snapshot: payments }).findings, []);
  });

  it('says nothing when the pull request wires the experiment up for the first time', () => {
    const before = {
      'client/PaymentModal.tsx': MODAL.split('\n').filter((_, i) => ![3, 4, 5, 14, 15, 16].includes(i)).join('\n'),
      'client/payments.ts': 'export function approve() {}\nexport function reject() {}\n',
    };
    const report = runCheck({ repo: new MemoryRepoView(before, wired), snapshot: payments });
    assert.deepEqual(report.findings, []);
  });

  it('still flags the same change in a pasted diff, where the base tree is unknown', () => {
    const diff = [
      'diff --git a/client/PaymentModal.tsx b/client/PaymentModal.tsx',
      '--- a/client/PaymentModal.tsx',
      '+++ b/client/PaymentModal.tsx',
      '@@ -1,4 +1,5 @@',
      " const amountDisplay = useExperiment('payment_amount_display');",
      " if (amountDisplay.variant === 'show_usd') {",
      '+  showDisclaimer();',
      '   showUsdAmount();',
      ' }',
      '',
    ].join('\n');
    assert.deepEqual(rulesOf(runCheck({ repo: new DiffOnlyRepoView(diff), snapshot: payments })), ['EG006']);
  });

  it('treats the code after a guard clause as the arm', () => {
    const file = (label: string) => [
      'export function Usd() {',
      "  const flag = useExperiment('payment_amount_display');",
      "  if (flag.variant !== 'show_usd') return null;",
      `  return <span>${label}</span>;`,
      '}',
      '',
      'export function Footer() {',
      '  return <footer>Aldor</footer>;',
      '}',
      '',
    ].join('\n');
    const base = { 'client/Usd.tsx': file('in USD') };
    assert.deepEqual(rulesOf(runCheck({ repo: new MemoryRepoView(base, { 'client/Usd.tsx': file('in US dollars') }), snapshot: payments })), ['EG006']);
    const footer = { 'client/Usd.tsx': file('in USD').replace('<footer>Aldor</footer>', '<footer>Aldor Labs</footer>') };
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(base, footer), snapshot: payments }).findings, []);
  });

  it('ends a Python branch where the indentation ends', () => {
    const file = (inside: string, after: string) => [
      'def amount(flag, sol):',
      "    if flag.variant == 'show_usd':",
      `        text = ${inside}`,
      '        return text',
      `    note = ${after}`,
      '    return note',
      '',
    ].join('\n');
    const base = { 'server/amount.py': file('usd(sol)', "'SOL only'") };
    const inside = { 'server/amount.py': file('usd(sol, digits=2)', "'SOL only'") };
    const after = { 'server/amount.py': file('usd(sol)', "'SOL'") };
    assert.deepEqual(rulesOf(runCheck({ repo: new MemoryRepoView(base, inside), snapshot: payments })), ['EG006']);
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(base, after), snapshot: payments }).findings, []);
  });

  it('reads branch shapes line by line', () => {
    assert.equal(branchesOn("const showUsd = flag.enabled && flag.variant === 'show_usd';", 'js'), true);
    assert.equal(aliasOf(["const showUsd = flag.enabled && flag.variant === 'show_usd';"], 0, 'js'), 'showUsd');
    assert.equal(aliasOf(["const label = flag.variant === 'show_usd' ? 'USD' : 'SOL';"], 0, 'js'), null);
    assert.equal(aliasOf(['const showUsd: boolean =', "  amountDisplay.variant === 'show_usd';"], 1, 'js'), 'showUsd');
    assert.equal(aliasOf(["if (flag?.variant === 'show_usd') {"], 0, 'js'), null);
    assert.equal(aliasOf(["show_usd = flag.variant == 'show_usd'"], 0, 'py'), 'show_usd');

    const lines = MODAL.split('\n');
    assert.deepEqual(aliasUses(lines, 4, 'showUsd', 'js'), [14]);
    assert.equal(regionEnd(lines, 14, 'js'), 16);

    // A one-line ternary is its own region; a switch arm ends at the next case.
    assert.equal(regionEnd(["const label = v === 'a' ? 'A' : 'B';", 'next();', 'more();'], 0, 'js'), 0);
    assert.equal(regionEnd(["  case 'show_usd':", '    usd();', '    break;', "  case 'sol_only':", '    sol();'], 0, 'js'), 2);
    // An else branch belongs to the same conditional.
    assert.equal(regionEnd(["if (v === 'a') {", '  a();', '} else {', '  b();', '}', 'after();'], 0, 'js'), 4);
    assert.equal(regionEnd(["} else if (v === 'a') {", '  a();', '}', 'after();'], 0, 'js'), 2);
  });
});

describe('EG007 leaves new identity code alone', () => {
  const config = parseConfigText('identity_patterns:\n  - aldor-visitor\n').config;
  const visitor = "const KEY = 'aldor-visitor';\nexport const visitorId = () => localStorage.getItem(KEY);\n";

  it('does not flag a pattern the base code never used', () => {
    const head = { ...wired, 'client/visitor.ts': visitor };
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(wired, head), snapshot: payments, config }).findings, []);
  });

  it('flags a change to identity code that already exists', () => {
    const base = { ...wired, 'client/visitor.ts': visitor };
    const renamed = { ...wired, 'client/visitor.ts': visitor.replace('aldor-visitor', 'aldor-user') };
    assert.deepEqual(rulesOf(runCheck({ repo: new MemoryRepoView(base, renamed), snapshot: payments, config })), ['EG007']);
    const second = { ...base, 'client/session.ts': "sessionStorage.setItem('aldor-visitor', id);\n" };
    assert.deepEqual(rulesOf(runCheck({ repo: new MemoryRepoView(base, second), snapshot: payments, config })), ['EG007']);
  });
});

describe('EG001 words the finding by what the metric is for', () => {
  const drop = (event: string) => ({ ...wired, 'client/payments.ts': EVENTS.replace(`  trackEvent('${event}');\n`, '') });

  it('calls a goal metric a conversion', () => {
    const f = runCheck({ repo: new MemoryRepoView(wired, drop('payment_approved')), snapshot: payments }).findings[0];
    assert.equal(f.rule, 'EG001');
    assert.match(f.consequence, /Every conversion for "Payment amount display" stops counting/);
  });

  it('calls a guardrail a guardrail', () => {
    const f = runCheck({ repo: new MemoryRepoView(wired, drop('payment_rejected')), snapshot: payments }).findings[0];
    assert.equal(f.rule, 'EG001');
    assert.match(f.consequence, /guardrail for "Payment amount display"/);
    assert.doesNotMatch(f.consequence, /conversion/);
  });

  it('says which way a half-removed event skews an arm', () => {
    const twice = { ...wired, 'client/retry.ts': "export const retry = () => trackEvent('payment_rejected');\n" };
    const f = runCheck({ repo: new MemoryRepoView(twice, { ...twice, 'client/payments.ts': drop('payment_rejected')['client/payments.ts'] }), snapshot: payments }).findings[0];
    assert.match(f.consequence, /look safe when it may not be/);
  });

  it('keeps the plain wording when Flagsmith gives no direction', () => {
    const snapshot = demoSnapshot(new Date('2026-11-27T08:00:00Z'));
    for (const e of snapshot.experiments) delete e.metrics;
    const base = { 'src/Card.tsx': "flagsmith.trackEvent('issue_opened');\n" };
    const f = runCheck({ repo: new MemoryRepoView(base, { 'src/Card.tsx': '\n' }), snapshot }).findings[0];
    assert.match(f.consequence, /Every conversion for "Connect-first onboarding" stops counting/);
  });
});

describe('wrapper functions', () => {
  const wrapped = {
    'client/PaymentModal.tsx': MODAL.replace("useExperiment('payment_amount_display')", "useVariant('payment_amount_display')"),
    'client/payments.ts': EVENTS.replaceAll('trackEvent(', 'track('),
  };
  const config = parseConfigText('calls:\n  exposure: [useVariant]\n  conversion: [track]\n').config;
  const noCall = { ...wrapped, 'client/PaymentModal.tsx': wrapped['client/PaymentModal.tsx'].replace("useVariant('payment_amount_display')", '{ variant: "sol_only" }') };

  it('notes a flag and events it can name but not read', () => {
    const report = runCheck({ repo: new MemoryRepoView(wrapped, wrapped), snapshot: payments });
    assert.equal(report.notes?.length, 2);
    assert.match(report.notes![0], /`payment_amount_display` \(client\/PaymentModal\.tsx:4\)/);
    assert.match(report.notes![0], /calls\.exposure/);
    assert.match(report.notes![1], /`payment_approved` \(client\/payments\.ts:3\), `payment_rejected` \(client\/payments\.ts:6\)/);
    assert.match(renderMarkdown(report), /> \*\*Note:\*\* Guard cannot see where/);
    assert.match(renderText(report), /note {2}Guard cannot see where payment_amount_display/);
  });

  it('misses a removed wrapper call until the wrapper is listed', () => {
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(wrapped, noCall), snapshot: payments }).findings, []);
    const report = runCheck({ repo: new MemoryRepoView(wrapped, noCall), snapshot: payments, config });
    assert.deepEqual(rulesOf(report), ['EG002']);
    assert.equal(report.verdict, 'block');
  });

  it('reads listed wrappers like SDK calls and drops the note', () => {
    const report = runCheck({ repo: new MemoryRepoView(wrapped, wrapped), snapshot: payments, config });
    assert.equal(report.notes, undefined);
    const typo = { ...wrapped, 'client/retry.ts': "export const retry = () => track('paymentApproved');\n" };
    assert.deepEqual(rulesOf(runCheck({ repo: new MemoryRepoView(wrapped, typo), snapshot: payments, config })), ['EG009']);
    const dynamic = { ...wrapped, 'client/retry.ts': 'export const send = (name: string) => track(name);\n' };
    assert.deepEqual(rulesOf(runCheck({ repo: new MemoryRepoView(wrapped, dynamic), snapshot: payments, config })), ['EG011']);
  });

  it('does not mistake a longer name for a listed wrapper', () => {
    const other = { ...wrapped, 'client/retry.ts': "export const retry = () => soundtrack('paymentApproved');\n" };
    assert.deepEqual(runCheck({ repo: new MemoryRepoView(wrapped, other), snapshot: payments, config }).findings, []);
  });

  it('adds no note when the pull request is what removed the call', () => {
    const gone = { ...wired, 'client/PaymentModal.tsx': MODAL.replace("useExperiment('payment_amount_display')", "flags.read('payment_amount_display')") };
    const report = runCheck({ repo: new MemoryRepoView(wired, gone), snapshot: payments });
    assert.deepEqual(rulesOf(report), ['EG002']);
    assert.equal(report.notes, undefined);
  });

  it('adds no note for an experiment that lives in another codebase, or for a pasted diff', () => {
    assert.equal(runCheck({ repo: new MemoryRepoView({ 'a.ts': 'export {};\n' }, { 'a.ts': 'export {};\n' }), snapshot: payments }).notes, undefined);
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const k = 'x';\n+const k = 'payment_amount_display';\n";
    assert.equal(runCheck({ repo: new DiffOnlyRepoView(diff), snapshot: payments }).notes, undefined);
  });

  it('rejects wrapper names that are not function names', () => {
    assert.throws(() => parseConfigText('calls:\n  exposure: ["use Variant("]\n'), /calls\.exposure/);
    assert.deepEqual(parseConfigText('calls:\n  conversion: [analytics.track]\n').config.calls, { exposure: [], conversion: ['analytics.track'] });
  });
});

describe('a block that GitHub will not enforce', () => {
  const ctx: GitHubContext = {
    token: 't', apiUrl: 'https://api.github.test', repo: 'acme/shop', labels: [], baseRef: 'release/1.0',
    pr: { number: 7, title: 'x' },
  };
  const unprotected = { enabled: false, required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] } };

  async function withGitHub<T>(routes: Record<string, unknown>, run: () => Promise<T>): Promise<{ result: T; asked: string[] }> {
    const real = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const path = String(input).replace(ctx.apiUrl, '').replace(/\?.*$/, '');
      asked.push(path);
      if (!(path in routes)) return new Response('Not Found', { status: 404 });
      return new Response(JSON.stringify(routes[path]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    try { return { result: await run(), asked }; } finally { globalThis.fetch = real; }
  }

  it('says so when the base branch requires no status check', async () => {
    const { result, asked } = await withGitHub({
      '/repos/acme/shop/rules/branches/release/1.0': [{ type: 'pull_request' }],
      '/repos/acme/shop/branches/release/1.0': { name: 'release/1.0', protection: unprotected },
    }, () => unenforcedNote(ctx, 'guard'));
    assert.deepEqual(asked, ['/repos/acme/shop/rules/branches/release/1.0', '/repos/acme/shop/branches/release/1.0']);
    assert.match(result ?? '', /GitHub will still allow this merge: `release\/1\.0` does not require any status check/);
    assert.match(result ?? '', /requires the status check `guard`/);
  });

  it('stays quiet when a ruleset or branch protection requires a check', async () => {
    const ruleset = await withGitHub({
      '/repos/acme/shop/rules/branches/release/1.0': [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'guard', integration_id: 15368 }] } }],
    }, () => unenforcedNote(ctx, 'guard'));
    assert.equal(ruleset.result, null);
    const classic = await withGitHub({
      '/repos/acme/shop/rules/branches/release/1.0': [],
      '/repos/acme/shop/branches/release/1.0': { protection: { enabled: true, required_status_checks: { enforcement_level: 'non_admins', contexts: ['guard'], checks: [] } } },
    }, () => unenforcedNote(ctx, 'guard'));
    assert.equal(classic.result, null);
  });

  it('stays quiet when GitHub will not say', async () => {
    const { result } = await withGitHub({}, () => unenforcedNote(ctx, 'guard'));
    assert.equal(result, null);
    assert.equal(await unenforcedNote({ ...ctx, baseRef: undefined }, 'guard'), null);
  });

  it('puts the note in the comment, ahead of other notes', () => {
    const report = runCheck({ repo: new MemoryRepoView(wired, { ...wired, 'client/payments.ts': EVENTS.replace("'payment_approved'", "'paymentApproved'") }), snapshot: payments });
    assert.equal(report.verdict, 'block');
    assert.equal(withNote(report, null), report);
    const noted = withNote({ ...report, notes: ['second'] }, 'GitHub will still allow this merge.');
    assert.deepEqual(noted.notes, ['GitHub will still allow this merge.', 'second']);
    const md = renderMarkdown(noted);
    assert.ok(md.indexOf('**Ways forward**') < md.indexOf('> **Note:** GitHub will still allow this merge.'));
  });
});
