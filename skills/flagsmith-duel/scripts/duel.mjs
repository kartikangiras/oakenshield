#!/usr/bin/env node
/*
 * flagsmith-duel: settle a disagreement between competing versions with one Flagsmith experiment.
 *
 * Every Flagsmith read and write goes through the `flagsmith` CLI. Each command prints one line
 * of JSON with a `next` field saying what to do now; the details people want are written to files
 * beside the plan. No dependencies, Node 20 or later.
 *
 *   init <flag>      write a plan to fill in
 *   plan             read-only: check the plan, say what `start` would do, print the approval code
 *   approve          a person confirms on their own terminal (needed for protected environments)
 *   start            create the flag, the versions, the metrics and the experiment; start it; seal it
 *   audit            compare Flagsmith with the seal: nothing may change while the experiment runs
 *   verdict          once every arm has enough visitors: read the results and apply the plan's rule
 *   finish           complete the experiment with the decision, so the flag serves the winner
 *   stop             end the run early without a winner: every visitor gets the control version again
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const BIN = process.env.FLAGSMITH_BIN ?? 'flagsmith';
/** Environments nothing here writes to without a person at a terminal. Add names in the plan's `protect`. */
const PROTECTED = /prod|live/i;
/** Identities evaluated after a start or finish to see what the SDK really serves. No events are sent for them. */
const SERVE_CHECK = 30;

class Stop extends Error {
  constructor(message, next, extra = {}) { super(message); this.next = next; this.extra = extra; }
}
const say = (o, code = 0) => { process.stdout.write(JSON.stringify(o) + '\n'); process.exit(code); };
const sha = s => createHash('sha256').update(s).digest('hex');
const short = s => sha(s).slice(0, 10);
const canonical = v => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  : JSON.stringify(v);
const pct = x => `${(100 * x).toFixed(1)}%`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2);
const command = argv.shift();
const opts = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) rest.push(a);
  else if (['version', 'guardrail'].includes(a.slice(2))) (opts[a.slice(2)] ??= []).push(argv[++i]);
  else if (['approve', 'environment', 'file', 'project', 'goal', 'min', 'hypothesis', 'name'].includes(a.slice(2))) opts[a.slice(2)] = argv[++i];
  else opts[a.slice(2)] = true;
}
const planPath = resolve(opts.file ?? (command === 'init' ? 'duel.json' : rest[0] ?? 'duel.json'));
const beside = suffix => planPath.replace(/\.json$/, '') + suffix;
const readJson = p => JSON.parse(readFileSync(p, 'utf8'));
const writeJson = (p, v) => writeFileSync(p, JSON.stringify(v, null, 2) + '\n');
/** Paths are printed relative to where the command ran: shorter to read, and to pay for. */
const shown = p => relative(process.cwd(), p) || '.';

// ---------------------------------------------------------------- the Flagsmith CLI
let project;
function cli(args, input) {
  try {
    return execFileSync(BIN, ['--no-input', ...(project ? ['-p', String(project)] : []), ...args], {
      input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Stop('The flagsmith CLI is not installed.', 'Install it (brew install Flagsmith/tap/flagsmith), then: flagsmith login');
    const line = String(e.stderr || e.message).split('\n').find(l => l.trim()) ?? 'failed';
    throw new Stop(`flagsmith ${args.slice(0, 3).join(' ')}: ${line.replace(/^Error:\s*/, '')}`);
  }
}
const cliJson = (args, input) => JSON.parse(cli([...args, '--json'], input));
/** One Admin API call through `flagsmith api`; --jq keeps only the fields this script uses. */
function api(path, { method, body, jq } = {}) {
  const text = cli(['api', `api/v1/${path}`, ...(method ? ['-X', method] : []), ...(body ? ['--input', '-'] : []), ...(jq ? ['--jq', jq] : [])],
    body ? JSON.stringify(body) : undefined);
  if (!text.trim()) return null;
  // --jq prints a lone string without its quotes.
  try { return JSON.parse(text); } catch { return text.trim(); }
}
const tryCli = f => { try { return f(); } catch (e) { if (e instanceof Stop) return null; throw e; } };

// ---------------------------------------------------------------- the plan
function loadPlan() {
  if (!existsSync(planPath)) throw new Stop(`No plan at ${planPath}.`, 'init <flag> --environment <name>, then fill the plan in');
  let p;
  try { p = readJson(planPath); } catch (e) { throw new Stop(`The plan is not valid JSON: ${e.message}`); }
  const bad = [];
  const key = /^[a-z][a-z0-9_]*$/;
  if (!key.test(p.flag ?? '')) bad.push('flag: lower case letters, digits and underscores');
  if (!p.environment) bad.push('environment: its name or client-side key');
  if (!p.hypothesis) bad.push('hypothesis: one sentence');
  const control = p.control ?? 'control';
  const versions = {};
  for (const [k, v] of Object.entries(p.versions ?? {})) {
    if (!key.test(k) || k === 'control') { bad.push(`versions.${k}: a key like "a" or "agent_a", not "control"`); continue; }
    let value = v.file ? tryRead(resolve(dirname(planPath), v.file)) : v.value;
    if (value && typeof value === 'object') value = JSON.stringify(value);
    if (typeof value !== 'string' || !value) { bad.push(`versions.${k}: needs a value (text or JSON) or a file`); continue; }
    if (value.length > 20000) bad.push(`versions.${k}: ${value.length} characters; a Flagsmith value holds 20,000`);
    if (value === control) bad.push(`versions.${k}: the same as the control value`);
    versions[k] = { value, by: v.by, hypothesis: v.hypothesis, predicts: v.predicts };
  }
  const keys = Object.keys(versions);
  if (keys.length < 1 || keys.length > 4) bad.push('versions: one to four challengers (a duel has two)');
  const split = p.split ?? Object.fromEntries(keys.map(k => [k, Math.floor(100 / (keys.length + 1))]));
  const used = keys.reduce((n, k) => n + (split[k] ?? 0), 0);
  if (keys.some(k => !(split[k] > 0)) || used >= 100) bad.push('split: a share above 0 for every version, leaving some for control');
  if (!p.goal?.event) bad.push('goal.event: the event that counts');
  const rule = { min_per_arm: 100, win_above: 0.95, harm_below: 0.05, ...(p.rule ?? {}) };
  if (!(rule.min_per_arm >= 50)) bad.push('rule.min_per_arm: at least 50 (Flagsmith shows no result below that)');
  // Watch metrics carry a number (a mean, a sum or a count per visitor). They are reported next to the verdict and never judged.
  const watch = (p.watch ?? []).filter(w => w.event).map(w => ({ name: w.name || w.event, event: w.event, aggregation: w.aggregation ?? 'mean' }));
  const judged = [p.goal?.event, ...(p.guardrails ?? []).map(g => g.event)];
  for (const w of watch) {
    if (!['mean', 'sum', 'count'].includes(w.aggregation)) bad.push(`watch.${w.event}: aggregation is mean, sum or count`);
    if (judged.includes(w.event) || watch.filter(x => x.event === w.event).length > 1) bad.push(`watch.${w.event}: an event has one metric in a plan`);
  }
  if (bad.length) throw new Stop(`The plan is incomplete: ${bad.join('; ')}.`, 'Fix the plan, then: plan');
  return {
    name: p.name || `${p.flag} duel`, flag: p.flag, environment: p.environment, project: p.project, hypothesis: p.hypothesis, control, versions,
    split: { control: 100 - used, ...Object.fromEntries(keys.map(k => [k, split[k]])) },
    goal: { name: p.goal?.name || p.goal?.event, event: p.goal?.event },
    guardrails: (p.guardrails ?? []).filter(g => g.event).map(g => ({ name: g.name || g.event, event: g.event })),
    watch, rule, protect: p.protect ?? [], create_environment: p.create_environment === true,
  };
}
function tryRead(p) { try { return readFileSync(p, 'utf8').trim(); } catch { return undefined; } }

/** Everything an approval covers. Change any of it and the code changes. */
const planDigest = plan => short(canonical({
  flag: plan.flag, environment: plan.environment, control: plan.control, split: plan.split, rule: plan.rule,
  versions: Object.fromEntries(Object.entries(plan.versions).map(([k, v]) => [k, sha(v.value)])),
  goal: plan.goal.event, guardrails: plan.guardrails.map(g => g.event),
  // Only when the plan has any, so that a plan without them keeps the code it was approved under.
  ...(plan.watch.length ? { watch: plan.watch.map(w => `${w.event}:${w.aggregation}`) } : {}),
}));

function findEnvironment(plan) {
  const all = cliJson(['environment', 'list']);
  const want = String(plan.environment).toLowerCase();
  const env = all.find(e => e.api_key === plan.environment || e.name.toLowerCase() === want);
  return env ? { id: env.id, key: env.api_key, name: env.name } : null;
}
/** An environment the plan will create is judged by the name it will get, so a new one can be protected too. */
function isProtected(plan, env) {
  const { name, key } = env ?? { name: String(plan.environment), key: '' };
  return PROTECTED.test(name)
    || [...plan.protect, ...(process.env.FLAGSMITH_DUEL_PROTECT ?? '').split(',')].some(p => p && (p === key || p.toLowerCase() === name.toLowerCase()));
}

const variations = flag => tryCli(() => cliJson(['feature', 'variant', 'list', flag])) ?? [];
/** Flagsmith wants every variation of a flag in its experiment, so one the plan does not know stops the start. */
function refuseStrangers(plan, have) {
  const extra = have.filter(x => !plan.versions[x.key]);
  if (!extra.length) return;
  throw new Stop(`${plan.flag} has ${extra.length === 1 ? 'a version' : 'versions'} the plan does not mention: ${extra.map(x => x.key || `#${x.id}`).join(', ')}. An experiment has to include every version of its flag.`,
    `Add ${extra.length === 1 ? 'it' : 'them'} to the plan, or ask the person whether to delete: ${extra.map(x => `flagsmith feature variant delete ${plan.flag} ${x.id} --yes`).join(' ; ')}`);
}
const experimentsOn = (envKey, featureId) =>
  (api(`environments/${envKey}/experiments/`, { jq: '[(.results? // .)[] | {id, name, status, feature: (.feature.id? // .feature)}]' }) ?? [])
    .filter(e => e.feature === featureId);
/** A flag's versions are shared by every environment, so changing one touches experiments elsewhere too. */
function refuseIfRunningElsewhere(plan, featureId, envKey) {
  for (const e of cliJson(['environment', 'list'])) {
    if (e.api_key === envKey) continue;
    const open = experimentsOn(e.api_key, featureId).filter(x => x.status !== 'completed');
    if (open.length) throw new Stop(`${plan.flag} has an experiment that is ${open[0].status} in ${e.name}, and versions are shared by every environment. Changing them now would change that experiment.`,
      'Use versions that match what Flagsmith holds, wait for that experiment, or use another flag');
  }
}
const metricsIn = envKey =>
  api(`environments/${envKey}/experiment-metrics/`, { jq: '[(.results? // .)[] | {id, name, aggregation, event: .definition.event}]' }) ?? [];
const DETAIL = `{status, started_at, updated_at, metrics: [.metrics[].metric], audience: (.experiment_rollout.audience.segments // [] | length),
  rollout: (.experiment_rollout // {} | {enabled, share: .rollout_percentage, control: .feature_state_value.value, arms: [.multivariate_feature_state_values[]? | {id: .multivariate_feature_option, share: .percentage_allocation}]}),
  variations: [.feature.multivariate_options[] | {id, key, value: .string_value}]}`;

/** What the SDK serves: evaluates throwaway identities with `flagsmith eval`, ten at a time. */
async function served(flag, envKey, n = SERVE_CHECK) {
  const one = i => new Promise((done, fail) => execFile(BIN,
    ['--no-input', ...(project ? ['-p', String(project)] : []), 'eval', flag, '-e', envKey, '--identity', `duel-check-${i}`, '--jq', '{variant, value, enabled}'],
    (err, out, errText) => err ? fail(new Stop(`flagsmith eval: ${String(errText || err.message).trim().split('\n')[0]}`)) : done(JSON.parse(out))));
  const seen = {};
  for (let i = 0; i < n; i += 10) {
    for (const r of await Promise.all(Array.from({ length: Math.min(10, n - i) }, (_, j) => one(i + j)))) {
      const arm = r.enabled ? (r.variant ?? 'control') : 'off';
      (seen[arm] ??= { n: 0, value: r.value }).n++;
    }
  }
  return seen;
}

/** Flagsmith's edge takes a few seconds to follow a change, so a serve check is repeated until it holds. */
async function settled(read, good) {
  let last;
  for (let i = 0; i < 6; i++) {
    last = await read();
    if (good(last)) break;
    await sleep(3000);
  }
  return last;
}

/** Where the repo uses the flag and the events: `git grep`, so nothing is read into the conversation. */
function usedInCode(words) {
  return Object.fromEntries(words.map(w => {
    try { return [w, execFileSync('git', ['grep', '-l', '-F', '--', w], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').filter(Boolean).length]; }
    catch { return [w, 0]; }
  }));
}

// ---------------------------------------------------------------- approvals
function requireApproval(step, code, protectedEnv) {
  if (opts.approve !== code) {
    throw new Stop(opts.approve ? `That approval code is for something else. What would happen now has the code ${code}.` : `${step} needs a person's approval.`,
      `${{ start: 'Show the person the plan line and ask.', finish: 'Show the person the verdict line and ask.', stop: 'Tell the person why and ask.' }[step]} After a yes: ${step} --approve ${code}`);
  }
  if (!protectedEnv) return;
  const given = existsSync(beside('.approvals.json')) ? readJson(beside('.approvals.json'))[step] : null;
  if (given?.code !== code) {
    throw new Stop(`This environment is protected: ${step} also needs the person to confirm on their own terminal.`,
      `Ask the person to run in their terminal: node ${process.argv[1]} approve ${planPath} ${step}`);
  }
}

// ---------------------------------------------------------------- statistics (our own: the head-to-head and the split check)
const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
/** Two-sided p-value for a difference between two proportions (pooled z-test). */
function twoProportionP(x1, n1, x2, n2) {
  const p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return 1;
  return 1 - erf(Math.abs(x1 / n1 - x2 / n2) / se / Math.SQRT2);
}
/** One-sided Fisher exact test: how likely a version has this few conversions, or fewer, if it is no worse than control. */
function fewerP(xv, nv, xc, nc) {
  const lf = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const choose = (n, k) => lf(n) - lf(k) - lf(n - k);
  const all = xv + xc;
  let p = 0;
  for (let i = Math.max(0, all - nc); i <= xv; i++) p += Math.exp(choose(nv, i) + choose(nc, all - i) - choose(nv + nc, all));
  return Math.min(1, p);
}
/** How likely a split at least this uneven is when visitors are assigned as planned (chi-square goodness of fit). */
function splitP(counts, shares) {
  const total = counts.reduce((a, b) => a + b, 0), all = shares.reduce((a, b) => a + b, 0);
  const y = counts.reduce((sum, c, i) => sum + (c - total * shares[i] / all) ** 2 / (total * shares[i] / all), 0) / 2;
  // The upper tail of chi-square with one degree of freedom fewer than there are versions, as a finite series.
  const df = counts.length - 1, odd = df % 2 === 1;
  let p = odd ? 1 - erf(Math.sqrt(y)) : 0;
  let term = odd ? Math.exp(-y) * Math.sqrt(y) * 2 / Math.sqrt(Math.PI) : Math.exp(-y);
  for (let j = odd ? 1.5 : 1; j <= df / 2; j++) { p += term; term *= y / j; }
  return Math.min(1, p);
}

// ---------------------------------------------------------------- commands
const commands = {
  init() {
    const flag = rest[0];
    if (!flag) throw new Stop('Which flag?', 'init <flag> --environment <name> --version <key>=<file> --version <key>=<file> --goal <event> --hypothesis "<one sentence>"');
    if (existsSync(planPath)) throw new Stop(`${shown(planPath)} already exists.`, 'Edit it, then: plan');
    const versions = Object.fromEntries((opts.version ?? []).map(v => [v.split('=')[0], { file: v.slice(v.indexOf('=') + 1) }]));
    const complete = Object.keys(versions).length > 0 && opts.environment && opts.goal && opts.hypothesis;
    writeJson(planPath, {
      ...(opts.name ? { name: opts.name } : {}), flag, environment: opts.environment ?? '', ...(opts.project ? { project: opts.project } : {}),
      create_environment: opts['new-environment'] === true, hypothesis: opts.hypothesis ?? '', control: 'control',
      versions: complete ? versions : { a: { by: '', hypothesis: '', file: '' }, b: { by: '', hypothesis: '', value: '' } },
      goal: { event: opts.goal ?? '' }, guardrails: (opts.guardrail ?? (complete ? [] : [''])).map(event => ({ event })),
      rule: { min_per_arm: Number(opts.min ?? 100), win_above: 0.95, harm_below: 0.05 },
    });
    // Everything was on the command line: go straight on to the plan, in the same line of output.
    if (complete) return { wrote: shown(planPath), ...commands.plan() };
    return { ok: true, wrote: shown(planPath), next: 'Fill in the plan: name the version keys, give each a value or a file beside the plan, name the events. Then: plan' };
  },

  plan() {
    const plan = loadPlan();
    project = plan.project;
    const env = findEnvironment(plan);
    if (!env && !plan.create_environment) throw new Stop(`There is no environment called "${plan.environment}".`, 'Use an existing one, or set "create_environment": true in the plan');
    const feature = tryCli(() => cliJson(['feature', 'get', plan.flag]));
    const will = [];
    if (!env) will.push(`create environment ${plan.environment}`);
    if (!feature) will.push(`create flag ${plan.flag}`);
    const have = feature ? variations(plan.flag) : [];
    refuseStrangers(plan, have);
    for (const [k, v] of Object.entries(plan.versions)) {
      const old = have.find(x => x.key === k);
      if (!old) will.push(`add version ${k}`); else if (old.value !== v.value) will.push(`replace version ${k}`);
    }
    const changes = will.some(w => / version /.test(w));
    if (feature && changes) refuseIfRunningElsewhere(plan, feature.id, env?.key);
    if (env && feature) {
      const open = experimentsOn(env.key, feature.id).filter(e => e.status !== 'completed');
      if (open.length) throw new Stop(`${plan.flag} already has an experiment that is ${open[0].status} in ${env.name} ("${open[0].name}"). A flag runs one experiment at a time.`,
        existsSync(beside('.seal.json')) ? 'This duel has started. Next: audit, then verdict' : 'Finish or complete that experiment first, or use another flag');
    }
    const events = [plan.goal.event, ...plan.guardrails.map(g => g.event)];
    const known = env ? metricsIn(env.key) : [];
    for (const e of events) if (!known.some(m => m.event === e && m.aggregation === 'occurrence')) will.push(`create metric for ${e}`);
    for (const w of plan.watch) if (!known.some(m => m.event === w.event && m.aggregation === w.aggregation)) will.push(`create metric for ${w.event} (${w.aggregation})`);
    will.push('create experiment', 'start it');
    const code = planDigest(plan);
    const code_ = usedInCode([plan.flag, ...events, ...plan.watch.map(w => w.event)]);
    const missing = Object.entries(code_).filter(([, n]) => n === 0).map(([w]) => w);
    return {
      ok: true, flag: plan.flag, environment: env?.name ?? plan.environment, protected: isProtected(plan, env),
      arms: plan.split, goal: plan.goal.event, guardrails: plan.guardrails.map(g => g.event),
      ...(plan.watch.length ? { watch: plan.watch.map(w => `${w.event} (${w.aggregation}, shown and not judged)`) } : {}),
      rule: `needs ${plan.rule.min_per_arm} visitors per arm; a version wins above a ${pct(plan.rule.win_above)} chance to beat control on the goal, unless its chance to beat control on a guardrail is below ${pct(plan.rule.harm_below)}`,
      will, files_using: code_,
      ...(missing.length ? { warning: `Nothing in this repository mentions ${missing.join(', ')}. Without the flag read and the event, no data arrives.` } : {}),
      ...(feature && changes ? { note: 'Versions belong to the flag, not the environment: every environment that serves one gets the new value.' } : {}),
      approve: code, next: `Show this line to the person and ask to start. After a yes: start --approve ${code}`,
    };
  },

  async approve() {
    const step = rest[1] ?? rest[0] ?? 'start';
    if (!['start', 'finish', 'stop'].includes(step)) throw new Stop('approve start, approve finish or approve stop');
    // The question goes to stderr and the answer comes from stdin; stdout carries the JSON line and may be piped.
    if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Stop('approve only works when a person runs it in a terminal.', 'Ask the person to run it themselves');
    const plan = loadPlan();
    project = plan.project;
    // A start may be approved for an environment the plan is about to create.
    const env = findEnvironment(plan) ?? (step === 'start' && plan.create_environment ? { name: plan.environment, key: '' } : null);
    if (!env) throw new Stop(`There is no environment called "${plan.environment}".`);
    let code, what;
    if (step === 'start') {
      code = planDigest(plan);
      what = `Start an experiment on ${plan.flag} in ${env.name}: ${Object.entries(plan.split).map(([k, v]) => `${k} ${v}%`).join(', ')}; counting ${plan.goal.event}.`;
    } else if (step === 'stop') {
      if (!existsSync(beside('.seal.json'))) throw new Stop('This plan has not been started.');
      code = stopCode(readJson(beside('.seal.json')));
      what = `End the experiment on ${plan.flag} in ${env.name} without a winner. Every visitor gets the control version, and the run cannot be restarted.`;
    } else {
      if (!existsSync(beside('.verdict.json'))) throw new Stop('There is no verdict yet.', 'verdict');
      const v = readJson(beside('.verdict.json'));
      if (v.state !== 'decided') throw new Stop(`The verdict is "${v.state}", so there is nothing to roll out.`);
      code = v.approve;
      what = `Complete the experiment on ${plan.flag} in ${env.name} and serve ${v.winner} to everyone. ${v.why}`;
    }
    process.stderr.write(`\n${what}\nApproval code ${code}.\n`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    // A terminal that closes before an answer is a refusal, not a crash.
    const typed = (await rl.question(`Type the environment's name (${env.name}) to approve, anything else to refuse: `).catch(() => '')).trim();
    rl.close();
    if (typed !== env.name) return { ok: false, approved: false, next: 'The person refused. Do not continue.' };
    const file = beside('.approvals.json');
    const all = existsSync(file) ? readJson(file) : {};
    all[step] = { code, at: new Date().toISOString(), by: process.env.USER ?? 'unknown' };
    writeJson(file, all);
    return { ok: true, approved: step, code, next: `${step} --approve ${code}` };
  },

  async start() {
    const plan = loadPlan();
    project = plan.project;
    let env = findEnvironment(plan);
    const code = planDigest(plan);
    requireApproval('start', code, isProtected(plan, env));
    const begun = existsSync(beside('.seal.json')) ? readJson(beside('.seal.json')) : null;
    if (begun?.started_at) throw new Stop('This plan has already been started (there is a seal beside it).', 'audit, then verdict');
    if (begun) return finishStart(plan, begun);
    if (!env) {
      cli(['environment', 'create', plan.environment, '--description', `Made for the duel on ${plan.flag}. Safe to delete afterwards.`]);
      env = findEnvironment(plan);
    }
    // The flag. Created off, so every other environment keeps serving nothing new.
    const feature = tryCli(() => cliJson(['feature', 'get', plan.flag]))
      ?? cliJson(['feature', 'create', plan.flag, '--value', plan.control, '--description', `${plan.name}. ${plan.hypothesis}`.slice(0, 255)]);
    const open = experimentsOn(env.key, feature.id).filter(e => e.status !== 'completed');
    if (open.length) throw new Stop(`${plan.flag} already has an experiment that is ${open[0].status} in ${env.name}.`, 'Complete it first, or use another flag');
    const have = variations(plan.flag);
    refuseStrangers(plan, have);
    if (Object.entries(plan.versions).some(([k, v]) => have.find(x => x.key === k)?.value !== v.value)) refuseIfRunningElsewhere(plan, feature.id, env.key);
    // The versions. Keys can only be set by `variant add`, and an existing value is replaced whole.
    for (const [k, v] of Object.entries(plan.versions)) {
      const old = have.find(x => x.key === k);
      if (!old) cli(['feature', 'variant', 'add', plan.flag, '--key', k, '--weight', '0', '--value', v.value]);
      else if (old.value !== v.value) {
        const path = `projects/${feature.project ?? project ?? currentProject()}/features/${feature.id}/mv-options/${old.id}/`;
        api(path, { method: 'PUT', body: { ...api(path), string_value: v.value } });
      }
    }
    const made = Object.fromEntries(variations(plan.flag).filter(x => plan.versions[x.key]).map(x => [x.key, { id: x.id, sha: sha(x.value) }]));
    for (const [k, v] of Object.entries(plan.versions)) {
      if (made[k]?.sha !== sha(v.value)) throw new Stop(`Flagsmith does not hold version ${k} as planned.`, 'Look at the flag in Flagsmith, then: plan');
    }
    // The metrics: one per event, reused when the environment already has it.
    const metrics = {};
    for (const m of [plan.goal, ...plan.guardrails, ...plan.watch]) {
      const aggregation = m.aggregation ?? 'occurrence';
      const found = metricsIn(env.key).find(x => x.event === m.event && x.aggregation === aggregation);
      metrics[m.event] = found?.id ?? api(`environments/${env.key}/experiment-metrics/`, {
        body: { name: m.name, aggregation, direction: 'up', definition: { version: 1, event: m.event } }, jq: '.id',
      });
    }
    const experiment = api(`environments/${env.key}/experiments/`, {
      jq: '.id',
      body: {
        feature: feature.id, name: plan.name, hypothesis: plan.hypothesis,
        metrics: Object.values(metrics).map(metric => ({ metric, expected_direction: 'increase' })),
        experiment_rollout: {
          enabled: true, rollout_percentage: 100, feature_state_value: { type: 'string', value: plan.control },
          multivariate_feature_state_values: Object.entries(made).map(([k, v]) => ({ multivariate_feature_option: v.id, percentage_allocation: plan.split[k] })),
        },
      },
    });
    // Sealed before it runs: if the start fails half way, running start again picks up from here.
    const seal = { code, experiment, feature: feature.id, flag: plan.flag, environment: env, control: plan.control, split: plan.split, versions: made, metrics, started_at: null };
    writeJson(beside('.seal.json'), seal);
    return finishStart(plan, seal);
  },

  audit() { return audit(loadPlan()).line; },

  async verdict() {
    const plan = loadPlan();
    const a = audit(plan);
    if (!a.sealed) return a.line;
    const { seal } = a;
    if (seal.decision === 'stopped') throw new Stop('This run was stopped without a winner, so it has no verdict.', 'A new run needs a new plan file');
    // Results are read once. Asking again gives the verdict that was read then, not a second look.
    if (existsSync(beside('.verdict.json'))) return { ...verdictLine(plan, readJson(beside('.verdict.json'))), read_once: true };
    const base = `environments/${seal.environment.key}/experiments/${seal.experiment}/`;
    // Flagsmith recomputes at most every five minutes; a refusal here just means the numbers are that fresh.
    tryCli(() => api(`${base}exposures/refresh/`, { method: 'POST' }));
    tryCli(() => api(`${base}results/refresh/`, { method: 'POST' }));
    await sleep(opts['no-wait'] ? 0 : 8000);
    const exposed = api(`${base}exposures/`, { jq: '.exposures // {} | {as_of, points: [.payload.timeseries.points[]?.new_identities], excluded: .payload.excluded_identities}' }) ?? {};
    const n = {};
    for (const p of exposed.points ?? []) for (const [k, v] of Object.entries(p)) n[k] = (n[k] ?? 0) + v;
    const arms = Object.keys(plan.split);
    const short_ = arms.filter(k => (n[k] ?? 0) < plan.rule.min_per_arm);
    if (short_.length) {
      // Outcomes stay unread until the planned sample is in: reading them early is how false winners happen.
      return { ok: true, state: 'collecting', visitors: Object.fromEntries(arms.map(k => [k, n[k] ?? 0])), need: plan.rule.min_per_arm, counted_at: exposed.as_of,
        next: `Conversions are not read before every arm has ${plan.rule.min_per_arm}. Flagsmith recounts at most every five minutes, so visitors after counted_at are not in yet. Send more or wait, then: verdict` };
    }
    const r = api(`${base}results/`, { jq: '.results // {} | {as_of, srm: .payload.srm_p_value, metrics: [.payload.metrics[]? | {id: .metric_id, variants, inference}]}' }) ?? {};
    const of = event => r.metrics?.find(m => m.id === seal.metrics[event]);
    const goal = of(plan.goal.event);
    if (!goal || arms.some(k => !goal.variants?.[k])) {
      return { ok: true, state: 'computing', visitors: n, next: 'Flagsmith has not computed the results yet. Wait five minutes, then: verdict' };
    }
    const row = (m, k) => {
      const v = m?.variants?.[k]; const i = m?.inference?.[k];
      return v ? { visitors: v.n, converted: v.sum, rate: v.n ? v.sum / v.n : 0,
        ...(i ? { lift: i.lift, ci: [i.ci_low, i.ci_high], chance_to_win: i.chance_to_win } : {}) } : null;
    };
    const table = { [plan.goal.event]: Object.fromEntries(arms.map(k => [k, row(goal, k)])) };
    for (const g of plan.guardrails) table[g.event] = Object.fromEntries(arms.map(k => [k, row(of(g.event), k)]));
    // Watch metrics: Flagsmith's numbers as they are. No rule reads them.
    const watched = Object.fromEntries(plan.watch.map(w => [w.event, Object.fromEntries(arms.map(k => {
      const m = of(w.event); const v = m?.variants?.[k]; const i = m?.inference?.[k];
      return [k, v ? { visitors: v.n, sum: v.sum, mean: v.mean ?? (v.n ? v.sum / v.n : 0),
        ...(i ? { lift: i.lift, ci: [i.ci_low, i.ci_high], chance_to_win: i.chance_to_win } : {}) } : null];
    }))]));
    const g = table[plan.goal.event];
    const challengers = arms.filter(k => k !== 'control');
    // Flagsmith gives no estimate for a metric with few conversions. A guardrail it cannot judge is judged
    // on its counts with an exact test, so that a rule about guardrails is never passed by default.
    const ours = [];
    for (const x of plan.guardrails) for (const k of challengers) {
      const v = table[x.event][k], c = table[x.event].control;
      if (!v || !c || v.chance_to_win !== undefined) continue;
      v.fewer_p = fewerP(v.converted, v.visitors, c.converted, c.visitors);
      if (!ours.includes(x.event)) ours.push(x.event);
    }
    // Flagsmith can judge one version and not another on the same metric, so the record says who judged each.
    const judgedBy = event => {
      const exact = challengers.filter(k => table[event][k]?.fewer_p !== undefined);
      const fisher = 'our one-sided Fisher exact test on Flagsmith\'s counts (Flagsmith gave no estimate)';
      if (!exact.length) return 'Flagsmith';
      return exact.length === challengers.length ? fisher : `${exact.join(', ')}: ${fisher}; ${challengers.filter(k => !exact.includes(k)).join(', ')}: Flagsmith`;
    };
    const harmed = k => plan.guardrails.filter(x => (table[x.event][k]?.chance_to_win ?? table[x.event][k]?.fewer_p ?? 1) < plan.rule.harm_below).map(x => x.event);
    const notes = challengers.map(k => {
      const c = g[k].chance_to_win;
      const bad = harmed(k);
      const verdict = c === undefined ? 'not enough conversions for Flagsmith to judge' : c <= plan.rule.win_above ? `did not clear ${pct(plan.rule.win_above)}` : bad.length ? `harms ${bad.map(e => table[e][k].fewer_p !== undefined ? `${e} (our exact test)` : e).join(', ')}` : 'qualifies';
      return { k, qualifies: verdict === 'qualifies', text: `${k} ${pct(g[k].rate)}${c === undefined ? '' : ` (${pct(c)} chance to beat control)`}: ${verdict}` };
    });
    const qualified = notes.filter(x => x.qualifies).map(x => x.k).sort((a, b) => g[b].rate - g[a].rate);
    let state = 'decided', winner = qualified[0] ?? 'control', why;
    const headToHead = challengers.length === 2
      ? { between: challengers, p_value: twoProportionP(g[challengers[0]].converted, g[challengers[0]].visitors, g[challengers[1]].converted, g[challengers[1]].visitors), note: 'Our own two-proportion z-test on Flagsmith\'s counts; Flagsmith compares each version with control only.' }
      : undefined;
    // Flagsmith's own split check when it gives one (it gave none for three versions), otherwise ours on its visitor counts.
    const srm = r.srm ?? splitP(arms.map(k => g[k].visitors), arms.map(k => plan.split[k]));
    if (srm < 0.001) {
      state = 'void'; winner = null;
      why = `The visitors did not split as planned (sample ratio mismatch, p = ${srm.toExponential(1)}), so no version is declared the winner.`;
    } else {
      why = `Control ${pct(g.control.rate)}. ${notes.map(x => x.text).join('. ')}.`
        + (qualified.length === 2 ? ` Both qualify; ${winner} has the higher rate${headToHead.p_value < 0.05 ? '' : `, though the two are not separable from each other (p = ${headToHead.p_value.toFixed(2)})`}.` : '')
        + (qualified.length === 0 ? ' Neither beats the control version, so it stays.' : '')
        + (plan.guardrails.length && !challengers.some(k => harmed(k).length) ? ` No guardrail fell${ours.length ? ` (${ours.join(', ')}: our exact test, Flagsmith gave no estimate)` : ''}.` : '');
    }
    // How well each version's author predicted the outcome, when the plan recorded predictions.
    const scores = Object.fromEntries(Object.entries(plan.versions).filter(([, v]) => v.predicts).map(([k, v]) => {
      const errs = arms.filter(a => typeof v.predicts[a] === 'number').map(a => Math.abs(v.predicts[a] - g[a].rate));
      return [k, { by: v.by, predicted: v.predicts, mean_abs_error: errs.length ? errs.reduce((x, y) => x + y, 0) / errs.length : null }];
    }));
    const counts = Object.fromEntries(arms.map(k => [k, `${g[k].converted}/${g[k].visitors}`]));
    const approve = state === 'decided' ? short(canonical({ plan: seal.code, experiment: seal.experiment, winner, counts })) : undefined;
    const verdict = {
      state, winner, why, approve, experiment: seal.experiment, environment: seal.environment.name, flag: plan.flag, read_at: new Date().toISOString(),
      results_as_of: r.as_of, sample_ratio_p: srm, sample_ratio_by: r.srm === null || r.srm === undefined ? 'our chi-square test on Flagsmith\'s visitor counts' : 'Flagsmith',
      excluded_visitors: exposed.excluded ?? 0, rule: plan.rule, table, head_to_head: headToHead, predictions: scores,
      guardrails_by: Object.fromEntries(plan.guardrails.map(x => [x.event, judgedBy(x.event)])),
      ...(plan.watch.length ? { watch: watched } : {}),
    };
    writeJson(beside('.verdict.json'), verdict);
    return verdictLine(plan, verdict);
  },

  async finish() {
    const plan = loadPlan();
    if (!existsSync(beside('.verdict.json'))) throw new Stop('There is no verdict yet.', 'verdict');
    const v = readJson(beside('.verdict.json'));
    if (v.state !== 'decided') throw new Stop(`The verdict is "${v.state}", so there is nothing to roll out.`, 'Tell the person');
    const a = audit(plan);
    if (!a.sealed) return a.line;
    const { seal } = a;
    requireApproval('finish', v.approve, isProtected(plan, seal.environment));
    const body = v.winner === 'control' ? { rollout_decision: 'control' } : { rollout_decision: 'variant', rollout_variant: seal.versions[v.winner].id };
    const done = api(`environments/${seal.environment.key}/experiments/${seal.experiment}/complete/`, { body, jq: '{status, ended_at}' });
    const removed = [];
    if (opts['remove-losers']) {
      for (const [k, x] of Object.entries(seal.versions)) {
        if (k !== v.winner) { cli(['feature', 'variant', 'delete', plan.flag, String(x.id), '--yes']); removed.push(k); }
      }
    }
    const want = v.winner === 'control' ? plan.control : plan.versions[v.winner].value;
    const rightIn = seen => Object.values(seen).filter(s => s.value === want).reduce((n, s) => n + s.n, 0);
    const right = rightIn(await settled(() => served(plan.flag, seal.environment.key, 10), x => rightIn(x) === 10));
    writeJson(beside('.seal.json'), { ...seal, completed_at: done.ended_at, decision: v.winner });
    return {
      ok: right === 10, status: done.status, serving: v.winner, checked: `${right} of 10 test identities get ${v.winner}`, removed,
      next: right === 10 ? 'Done. Tell the person what now ships and where the verdict is.' : 'The flag is not serving the winner to everyone. Tell the person.',
    };
  },

  async stop() {
    const plan = loadPlan();
    if (!existsSync(beside('.seal.json'))) throw new Stop('This plan has not been started.');
    const seal = readJson(beside('.seal.json'));
    if (seal.completed_at) throw new Stop('This run is already over.');
    project = plan.project;
    // Pausing is not enough: Flagsmith keeps serving every version while an experiment is paused.
    requireApproval('stop', stopCode(seal), isProtected(plan, seal.environment));
    const done = api(`environments/${seal.environment.key}/experiments/${seal.experiment}/complete/`, { body: { rollout_decision: 'control' }, jq: '{status, ended_at}' });
    const rightIn = seen => Object.values(seen).filter(x => x.value === plan.control).reduce((n, x) => n + x.n, 0);
    const right = rightIn(await settled(() => served(plan.flag, seal.environment.key, 10), x => rightIn(x) === 10));
    writeJson(beside('.seal.json'), { ...seal, completed_at: done.ended_at, decision: 'stopped' });
    return { ok: right === 10, status: done.status, serving: 'control', checked: `${right} of 10 test identities get control`,
      next: 'Tell the person the run ended without a winner. A completed experiment cannot be restarted; a new run needs a new plan file.' };
  },
};

const stopCode = seal => short(canonical({ stop: seal.experiment, plan: seal.code }));
/** The one line the verdict command prints, from the verdict file. */
function verdictLine(plan, v) {
  const goal = v.table[plan.goal.event];
  return {
    ok: true, state: v.state, winner: v.winner, why: v.why, read_at: v.read_at,
    arms: Object.fromEntries(Object.entries(goal).map(([k, x]) => [k, `${x.converted}/${x.visitors}`])), details: shown(beside('.verdict.json')),
    ...(v.state === 'decided' ? { approve: v.approve, next: `Show this line to the person and ask to roll out ${v.winner}. After a yes: finish --approve ${v.approve}` }
      : { next: 'Tell the person. Nothing is rolled out; stop ends the run.' }),
  };
}

/** Starts a sealed experiment that is not running yet, records when, and checks what the SDK serves. */
async function finishStart(plan, seal) {
  const env = seal.environment, experiment = seal.experiment;
  const at = `environments/${env.key}/experiments/${experiment}/`;
  if (api(at, { jq: '.status' }) === 'created') api(`${at}start/`, { method: 'POST', jq: '.status' });
  const started = api(at, { jq: '{status, started_at, updated_at}' });
  if (started.status !== 'running') throw new Stop(`Experiment ${experiment} is ${started.status}, not running.`, 'Tell the person');
  writeJson(beside('.seal.json'), { ...seal, started_at: started.started_at, updated_at: started.updated_at });
  const wrongIn = seen => Object.entries(seen).filter(([arm, s]) => arm === 'off' || (arm === 'control' ? s.value !== plan.control : s.value !== plan.versions[arm]?.value)).map(([arm]) => arm);
  const unservedIn = seen => Object.keys(plan.split).filter(k => !seen[k]);
  const seen = await settled(() => served(plan.flag, env.key), x => !wrongIn(x).length && !unservedIn(x).length);
  const wrong = wrongIn(seen), unserved = unservedIn(seen);
  return {
    ok: wrong.length === 0, experiment, status: started.status, environment: env.name,
    served: Object.fromEntries(Object.entries(seen).map(([k, v]) => [k, v.n])),
    ...(wrong.length ? { error: `The SDK serves something unplanned for: ${wrong.join(', ')}.` } : {}),
    ...(unserved.length ? { warning: `None of ${SERVE_CHECK} test identities got ${unserved.join(', ')}.` } : {}),
    seal: shown(beside('.seal.json')),
    next: wrong.length ? 'Tell the person; stop ends the run' : `Send visitors. Check with: audit. When each arm has ${plan.rule.min_per_arm}: verdict`,
  };
}

let cachedProject;
function currentProject() {
  return cachedProject ??= JSON.parse(cli(['config', '--jq', '.project.value']));
}

/** Compares Flagsmith with the seal. Flagsmith's API accepts edits to a running experiment, so this is the lock. */
function audit(plan) {
  project = plan.project;
  if (!existsSync(beside('.seal.json'))) throw new Stop('This plan has not been started.', 'plan');
  const seal = readJson(beside('.seal.json'));
  if (!seal.started_at) throw new Stop('The start did not finish, so the experiment is not running yet.', `start --approve ${seal.code}`);
  const live = api(`environments/${seal.environment.key}/experiments/${seal.experiment}/`, { jq: DETAIL });
  const drift = [];
  if (planDigest(plan) !== seal.code) drift.push('the plan file changed after the start');
  if (!seal.completed_at) {
    if (live.status !== 'running') drift.push(`the experiment is ${live.status}`);
    else if (seal.updated_at && live.updated_at !== seal.updated_at) drift.push(`the experiment was paused or edited at ${live.updated_at}`);
    if (live.audience) drift.push('the experiment was narrowed to an audience');
    if (live.rollout.control !== seal.control) drift.push('the control value changed');
    if (live.rollout.share !== 100 || live.rollout.enabled !== true) drift.push('the experiment no longer covers every visitor');
    for (const [k, v] of Object.entries(seal.versions)) {
      const share = live.rollout.arms.find(x => x.id === v.id)?.share;
      if (share !== seal.split[k]) drift.push(`split: ${k} ${seal.split[k]}% -> ${share === undefined ? 'removed' : `${share}%`}`);
    }
    for (const x of live.rollout.arms) if (!Object.values(seal.versions).some(v => v.id === x.id)) drift.push('split: an unplanned version is being served');
  }
  for (const [k, v] of Object.entries(seal.versions)) {
    const now = live.variations.find(x => x.id === v.id);
    if (!now) { if (!seal.completed_at) drift.push(`version ${k} was deleted`); }
    else if (sha(now.value) !== v.sha) drift.push(`version ${k} was edited`);
    else if (now.key !== k) drift.push(`version ${k} was renamed to ${now.key}`);
  }
  const wanted = Object.values(seal.metrics).sort().join();
  if ([...live.metrics].sort().join() !== wanted) drift.push('the metrics attached to the experiment changed');
  else {
    const now = metricsIn(seal.environment.key);
    for (const [event, id] of Object.entries(seal.metrics)) {
      const m = now.find(x => x.id === id);
      if (m?.event !== event) drift.push(`the metric for ${event} now counts ${m?.event ?? 'nothing'}`);
    }
  }
  const sealed = drift.length === 0;
  return {
    sealed, seal,
    line: sealed
      ? { ok: true, sealed: true, status: live.status, experiment: seal.experiment, since: seal.started_at, next: seal.completed_at ? `Completed${seal.decision === 'stopped' ? ', stopped without a winner' : ''}. Nothing more to do.` : 'verdict' }
      : { ok: false, sealed: false, status: live.status, drift, next: seal.completed_at
        ? `This run is over (${seal.decision === 'stopped' ? 'stopped without a winner' : `rolled out ${seal.decision}`}) and something changed in Flagsmith. Tell the person.`
        : `Something changed mid-run, so this run cannot give a verdict. Tell the person. After a yes: stop --approve ${stopCode(seal)}` },
  };
}

try {
  if (!commands[command]) throw new Stop(`Unknown command "${command ?? ''}".`, 'One of: init, plan, approve, start, audit, verdict, finish, stop');
  const line = await commands[command]();
  say(line, line.ok === false ? 2 : 0);
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  say({ ok: false, error: e.message, ...e.extra, ...(e.next ? { next: e.next } : {}) }, 1);
}
