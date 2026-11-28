/*
 * oakenshield-arena: two agents each write a trading playbook, a Flagsmith experiment on live
 * five minute prediction markets decides which one trades. Paper money only: no order is placed.
 *
 *   debate [dir]                     run the agents and write the record and the plan
 *   show [dir]                       print the record
 *   facts [dir]                      print the fact sheet the agents would get now
 *   plan | audit | verdict [dir]     Flagsmith steps the agent runs on its own
 *   approve [dir] start|finish|stop  a person's decision, typed on their own terminal
 *   start | finish | stop [dir] --approve <code>
 *   run [dir] [--dry] [--windows n]  the runner: trades every market with whatever the flag serves
 *   resume [dir] [--dry]             a person restarts the arena after its loss limit stopped it
 *   check [dir]                      the arena's own reading of its trade log, once the result was read
 *
 * Every Flagsmith write is the flagsmith-duel skill's script (skills/flagsmith-duel), so the
 * engine and an agent using the skill do exactly the same thing. The runner only reads the flag
 * and sends events, through Flagsmith's Node SDK.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { claude } from '@oakenshield/duel';
import { AGENTS, AGENT_KEYS, rivalOf, tapeText } from './agents.ts';
import type { Brief } from './agents.ts';
import { check } from './check.ts';
import { coinOf, debate, planOf } from './debate.ts';
import type { ArenaRecord } from './debate.ts';
import { flagsmithDesk, localDesk } from './desk.ts';
import { factSheet, loadPast } from './history.ts';
import { Ledger } from './ledger.ts';
import type { ArenaState } from './ledger.ts';
import { ASSETS } from './playbook.ts';
import type { Playbook } from './playbook.ts';
import { run } from './runner.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL = join(ROOT, 'skills/flagsmith-duel/scripts/duel.mjs');
const STEPS = ['plan', 'approve', 'start', 'audit', 'verdict', 'finish', 'stop'];
const DEFAULT_DIR = 'arenas/up-or-down';

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const out = (line = '') => process.stdout.write(line + '\n');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));

function loadBrief(dir: string): Brief {
  const brief = readJson<Brief>(join(dir, 'brief.json'));
  const unknown = brief.venue.assets.filter(a => !ASSETS.includes(a));
  if (unknown.length) throw new Error(`brief.json names assets without five minute markets: ${unknown.join(', ')}.`);
  const r = brief.risk;
  if (r && !(r.max_loss > 0 && Number.isInteger(r.over) && r.over > 0)) throw new Error('brief.json: risk needs max_loss above 0 and over as a whole number of markets.');
  return brief;
}

function show(record: ArenaRecord): void {
  const b = record.brief;
  out(record.name);
  out(`Goal: ${b.goal}`);
  out(`Measured: ${b.event.key}. Flag ${b.flag} in ${b.environment}. Paper money: ${b.venue.stake} dollars a market.`);
  out(`The agents saw ${record.past.seen} past markets (up won ${pct(record.past.up_seen)}); ${record.past.held} newer ones were held back (up won ${pct(record.past.up_held)}).`);
  for (const k of AGENT_KEYS) {
    const a = AGENTS[k];
    out();
    out(`${a.name} (${a.stance.toLowerCase()})`);
    const p = record.proposals[k];
    if (!p?.playbook) { out(`  Forfeits: the referee rejected its playbook. ${p?.referee.map(x => x.message).join(' ') ?? ''}`); continue; }
    out(`  Proposed:  "${p.playbook.name}", right on ${pct(p.seen!.rate)} of the markets it was shown${p.repaired ? ' (after one rejection by the referee)' : ''}`);
    for (const line of record.attacks[rivalOf(k)]?.attacks ?? []) out(`  Attacked:  ${line}`);
    const r = record.revisions[k];
    if (r) out(`  Revision:  ${r.changed}`);
    const f = record.finalists[k];
    if (!f) continue;
    out(`  Enters:    ${tapeText(f.playbook, f.seen).split('\n').join('\n             ')}`);
    out(`  Held out:  right on ${pct(f.held.rate)} of ${f.held.markets} markets it never saw`);
    out(`  Claims:    ${f.hypothesis}`);
    if (f.predicts) out(`  Predicts:  coin ${pct(f.predicts.control)}, Agent A ${pct(f.predicts.agent_a)}, Agent B ${pct(f.predicts.agent_b)}`);
  }
  out();
  out(`The coin: right on ${pct(record.coin.held.rate)} of the held out markets.${record.agreement === null ? '' : ` The two playbooks make the same call on ${pct(record.agreement)} of them.`}`);
  out(`${record.usage.calls} model calls, ${record.usage.seconds} s, ${record.usage.tokens.in + record.usage.tokens.out} tokens (${record.model}).`);
  for (const s of record.steps) out(`${s.at.slice(0, 16).replace('T', ' ')}  ${s.step}: ${summary(s.line)}`);
}

function summary(line: Record<string, unknown>): string {
  if (line.error) return String(line.error);
  if (line.drift) return `seal broken: ${(line.drift as string[]).join('; ')}`;
  if (line.why) return `${line.state}: ${line.why}`;
  if (line.state === 'collecting') return `collecting: ${JSON.stringify(line.visitors)} of ${line.need} markets per arm${line.counted_at ? `, counted at ${String(line.counted_at).slice(11, 19)} UTC` : ''}`;
  if (line.will) return `would ${(line.will as string[]).join(', ')}`;
  if (line.served) return `experiment ${line.experiment} is ${line.status}; test identities got ${JSON.stringify(line.served)}`;
  if (line.serving) return `${line.status}; ${line.checked}`;
  if (line.sealed) return `sealed, ${line.status}`;
  if (line.approved !== undefined) return line.approved ? `${line.approved} approved, code ${line.code}` : 'refused';
  return JSON.stringify(line);
}

/** Runs one step of the skill's script on this arena's plan and adds its answer to the record. */
function step(dir: string, name: string, args: string[]): number {
  const plan = join(dir, 'duel.json');
  const interactive = name === 'approve';
  const done = spawnSync(process.execPath, [SKILL, name, plan, ...args], { encoding: 'utf8', stdio: [interactive ? 'inherit' : 'ignore', 'pipe', 'inherit'] });
  const text = done.stdout.trim();
  let line: Record<string, unknown>;
  try { line = JSON.parse(text) as Record<string, unknown>; } catch { out(text); return done.status ?? 1; }
  const recordPath = join(dir, 'record.json');
  if (existsSync(recordPath)) {
    const record = readJson<ArenaRecord>(recordPath);
    record.steps.push({ at: new Date().toISOString(), step: name, line });
    writeJson(recordPath, record);
  }
  out(`${name}: ${summary(line)}`);
  if (line.approve && name === 'plan') out('A person decides the start. In your own terminal: npm run arena -- approve start');
  if (line.approve && name === 'verdict') out('A person decides the rollout. In your own terminal: npm run arena -- approve finish');
  if (line.next) out(`next: ${String(line.next).replace(/^Send visitors\./, 'Keep the runner going: npm run arena -- run.')}`);
  return done.status ?? 1;
}

/** Two plain playbooks for a rehearsal before the agents have written theirs. */
const sample = (name: string, first: 'up' | 'down'): Playbook => ({
  version: 1, kind: 'playbook', name,
  rules: [{ when: [{ signal: 'ret_5m', op: '>', value: 0 }], side: first }],
  otherwise: first === 'up' ? 'down' : 'up',
});

/** One runner per ledger: two would trade the same markets twice. */
async function alone<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const lock = join(dir, 'runner.lock');
  const held = existsSync(lock) ? Number(readFileSync(lock, 'utf8')) : 0;
  if (held && held !== process.pid) {
    let alive = true;
    try { process.kill(held, 0); } catch { alive = false; }
    if (alive) throw new Error(`A runner is already trading this arena (process ${held}). Stop it first.`);
  }
  writeFileSync(lock, String(process.pid));
  try { return await work(); } finally { rmSync(lock, { force: true }); }
}

/** A person's word that trading may go on after a halt, kept beside the trade log. */
interface Restart { halted_at: string; at: string; by: string }
const RESTARTS = 'restarts.json';
const restartedIn = (at: string) => (haltedAt: string): string | null => {
  try { return readJson<Restart[]>(join(at, RESTARTS)).find(r => r.halted_at === haltedAt)?.by ?? null; } catch { return null; }
};

/** A person's decision to trade again after the loss limit stopped the arena, typed on their own terminal. */
async function resume(dir: string, at: string): Promise<void> {
  const halted = new Ledger(at).halted;
  if (!halted) { out('resume: the loss limit has not stopped this arena, so there is nothing to restart.'); return; }
  if (restartedIn(at)(halted.at)) { out('resume: already approved. The runner picks it up when it runs: npm run arena -- run'); return; }
  // Same terms as the skill's approve: the question goes to stderr, the answer comes from a terminal.
  if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error('resume only works when a person runs it in a terminal.');
  const name = loadBrief(dir).environment;
  process.stderr.write(`\nThe loss limit stopped every version at ${halted.at.slice(11, 16)} UTC: ${halted.lost.toFixed(2)} paper dollars lost within ${halted.over} settled markets (the limit is ${halted.max_loss}).\nRestarting lets every version trade again, with losses counted from zero.\n`);
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const typed = (await rl.question(`Type the environment's name (${name}) to restart, anything else to leave it stopped: `).catch(() => '')).trim();
  rl.close();
  if (typed !== name) { out('resume: refused. The arena stays stopped.'); process.exitCode = 1; return; }
  const file = join(at, RESTARTS);
  const all = existsSync(file) ? readJson<Restart[]>(file) : [];
  all.push({ halted_at: halted.at, at: new Date().toISOString(), by: process.env.USER ?? 'unknown' });
  writeJson(file, all);
  out('resume: approved. A runner that is going picks it up within ten seconds; otherwise: npm run arena -- run');
}

/** The second reading: the trade log grouped by five minute window, written beside Flagsmith's verdict. */
function second(dir: string): void {
  const verdictPath = join(dir, 'duel.verdict.json');
  // It reads outcomes, so it waits for the one reading the rule allows. Nobody can decide early with it.
  if (!existsSync(verdictPath)) throw new Error('The result has not been read yet, and the check waits for it. First: verdict');
  const record = readJson<ArenaRecord>(join(dir, 'record.json'));
  const plan = readJson<Plan>(join(dir, 'duel.json'));
  const verdict = readJson<{ table?: Record<string, Record<string, { chance_to_win?: number }>> }>(verdictPath);
  const order = ['control', ...Object.keys(plan.versions)];
  const goal = verdict.table?.[record.brief.event.key] ?? {};
  const c = check(new Ledger(dir).trades.values(), order, Object.fromEntries(order.map(k => [k, goal[k]?.chance_to_win ?? null])));
  writeJson(join(dir, 'check.json'), c);
  const points = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
  out(`check: ${c.markets} settled markets in ${c.windows} five minute window${c.windows === 1 ? '' : 's'}; ${c.draws} draws of whole windows`);
  for (const k of order) {
    const a = c.arms[k]!, v = c.against_control[k], f = c.flagsmith[k];
    out(`  ${k.padEnd(8)} right on ${pct(a.rate)} of ${a.markets}, breaks even at ${pct(a.break_even)}, paper profit ${a.profit.toFixed(2)}`
      + (v ? `; ${points(v.diff)} points on the coin (95% of draws between ${points(v.low)} and ${points(v.high)}), ahead in ${pct(v.chance_to_win)} of draws${f == null ? '' : `, Flagsmith says ${pct(f)}`}` : ''));
  }
  out('This is a second reading. Flagsmith\'s result and the rule fixed before the start decide.');
}

interface Plan { control: string; versions: Record<string, { value: string }>; split: Record<string, number> }
interface Seal { environment: { key: string; name: string }; started_at: string | null; experiment: number }

async function runner(dir: string, flags: Set<string>, windows: number | undefined): Promise<void> {
  const dry = flags.has('--dry');
  const recordPath = join(dir, 'record.json');
  const planPath = join(dir, 'duel.json');
  const sealPath = join(dir, 'duel.seal.json');
  const record = existsSync(recordPath) ? readJson<ArenaRecord>(recordPath) : null;
  // Once the agents have run, the record's copy of the brief is the one that was agreed on.
  const brief = record?.brief ?? loadBrief(dir);
  // The loss limit is the operator's and may be set after the agents have run, so it comes from the brief on disk.
  const risk = loadBrief(dir).risk;
  const plan: Plan = existsSync(planPath) ? readJson<Plan>(planPath) : {
    control: JSON.stringify(coinOf(brief)),
    versions: { agent_a: { value: JSON.stringify(sample('Sample: with the move', 'up')) }, agent_b: { value: JSON.stringify(sample('Sample: against the move', 'down')) } },
    split: brief.split,
  };
  const order = ['control', ...Object.keys(plan.versions)];
  const used = Object.values(plan.split).reduce((n, x) => n + x, 0);
  const stop = new AbortController();
  process.once('SIGINT', () => { out('\nStopping after this step. Open trades settle the next time the runner starts.'); stop.abort(); });
  // A stray rejection (a socket closing late, say) must not end hours of trading.
  process.on('unhandledRejection', e => out(`  ${e instanceof Error ? e.message : String(e)}; carrying on`));
  const common = {
    venue: brief.venue, order, say: out, signal: stop.signal, ...(windows === undefined ? {} : { windows }),
    events: { placed: brief.placed, won: brief.event.key, ...(brief.watch[0] ? { profit: brief.watch[0].key } : {}) },
  };
  out(`Paper trading only. ${brief.venue.stake} dollars a market on ${brief.venue.assets.join(', ')}; no order is ever placed.`);
  if (risk) out(`Loss limit: every version stops once ${risk.over} settled markets in a row have lost ${risk.max_loss} paper dollars between them. Only a person restarts it.`);

  if (dry) {
    const at = join(dir, 'dry');
    mkdirSync(at, { recursive: true });
    out(`Rehearsal without Flagsmith: markets are split by a hash of their name. Trades go to ${at}/trades.jsonl.`);
    await alone(at, () => run({ ...common, dir: at, dry: true, ...(risk ? { risk, restarted: restartedIn(at) } : {}), desk: localDesk({ control: plan.control, versions: plan.versions, split: { control: 100 - used, ...plan.split } }) }));
    return;
  }

  if (!record || !existsSync(planPath)) throw new Error('This arena has no plan yet. First: debate. For a rehearsal without Flagsmith: run --dry');
  for (let waited = false; !stop.signal.aborted; waited = true) {
    if (existsSync(sealPath) && readJson<Seal>(sealPath).started_at) break;
    if (!waited) out('Waiting for the experiment to start (approve start, then start --approve <code>).');
    await sleep(3000);
  }
  if (stop.signal.aborted) return;
  const seal = readJson<Seal>(sealPath);
  out(`Experiment ${seal.experiment} in ${seal.environment.name}. Flagsmith decides which version trades each market.`);
  const pushUrl = process.env.ARENA_PUSH_URL;
  const token = process.env.OAKENSHIELD_TOKEN;
  // The server that shows the arena runs elsewhere, so it gets the state and the files beside it.
  const part = (name: string): unknown => { try { return readJson(join(dir, name)); } catch { return null; } };
  const publish = pushUrl && token ? async (state: ArenaState) => {
    const body = { state, record: part('record.json'), seal: part('duel.seal.json'), verdict: part('duel.verdict.json'), approvals: part('duel.approvals.json'), check: part('check.json') };
    await fetch(pushUrl, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  } : undefined;
  if (publish) out(`The state is also sent to ${new URL(pushUrl!).host} after every change.`);
  await alone(dir, () => run({
    ...common, dir, ...(publish ? { publish } : {}),
    target: brief.rule.min_per_arm, decided: () => existsSync(join(dir, 'duel.verdict.json')),
    ...(risk ? { risk, restarted: restartedIn(dir) } : {}),
    desk: flagsmithDesk({
      environmentKey: seal.environment.key, flag: brief.flag, warn: line => out(`  ${line}`),
      values: { control: plan.control, ...Object.fromEntries(Object.entries(plan.versions).map(([k, v]) => [k, v.value])) },
      ...(process.env.ARENA_FLAGSMITH_API ? { apiUrl: process.env.ARENA_FLAGSMITH_API } : {}),
      ...(process.env.ARENA_FLAGSMITH_EVENTS ? { eventsUrl: process.env.ARENA_FLAGSMITH_EVENTS } : {}),
    }),
  }));
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = 'show', ...rest] = argv;
  let model = process.env.ARENA_MODEL ?? 'sonnet';
  let windows: number | undefined;
  const flags = new Set<string>();
  const words: string[] = []; // the arena's directory, and the step `approve` is for
  const passed: string[] = []; // flags that go to the skill's script
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--model') model = rest[++i] ?? model;
    else if (a === '--windows') windows = Number(rest[++i]) || undefined;
    else if (a === '--approve') passed.push(a, rest[++i] ?? '');
    else if (a.startsWith('--')) { flags.add(a); passed.push(a); }
    else words.push(a);
  }
  // `approve` takes the step as its word; everything else takes the arena's directory.
  const dirArg = words.find(w => !['start', 'finish', 'stop'].includes(w));
  const dir = resolve(dirArg ?? join(ROOT, DEFAULT_DIR));
  const recordPath = join(dir, 'record.json');

  if (command === 'facts') {
    const brief = loadBrief(dir);
    const past = await loadPast(brief.venue.assets, brief.past.hours, brief.past.held_hours);
    out(factSheet(past.seen, past.from, past.cut));
    return;
  }
  if (command === 'debate') {
    if (existsSync(join(dir, 'duel.seal.json'))) throw new Error('This arena has started. Its record is closed; a new arena needs a new directory.');
    if (existsSync(recordPath) && !flags.has('--again')) throw new Error(`${recordPath} exists. Pass --again to run the agents again and replace it.`);
    const brief = loadBrief(dir);
    out(`Reading ${brief.past.hours} hours of prices for ${brief.venue.assets.length} assets.`);
    const past = await loadPast(brief.venue.assets, brief.past.hours, brief.past.held_hours);
    const record = await debate(claude(model), brief, past, model, out);
    writeJson(recordPath, record);
    out();
    show(record);
    if (AGENT_KEYS.every(k => !record.finalists[k])) { out('\nBoth agents forfeited, so there is nothing to test.'); process.exitCode = 1; return; }
    writeJson(join(dir, 'duel.json'), planOf(record, Number(process.env.FLAGSMITH_PROJECT) || undefined));
    out();
    process.exitCode = step(dir, 'plan', []);
    return;
  }
  if (command === 'show') { show(readJson<ArenaRecord>(recordPath)); return; }
  if (command === 'run') { await runner(dir, flags, windows); return; }
  if (command === 'check') { second(dir); return; }
  if (command === 'resume') { await resume(dir, flags.has('--dry') ? join(dir, 'dry') : dir); return; }
  if (STEPS.includes(command)) {
    process.exitCode = step(dir, command, [...words.filter(w => ['start', 'finish', 'stop'].includes(w)), ...passed]);
    return;
  }
  throw new Error(`Unknown command "${command}". One of: debate, show, facts, run, resume, check, ${STEPS.join(', ')}.`);
}
