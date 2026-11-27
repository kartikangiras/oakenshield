/*
 * oakenshield-duel: two agents propose competing first screens, a Flagsmith experiment decides.
 *
 *   debate [dir]                     run the agents and write the record and the plan
 *   show [dir]                       print the record
 *   plan | audit | verdict [dir]     Flagsmith steps the agent runs on its own
 *   approve [dir] start|finish|stop  a person's decision, typed on their own terminal
 *   start | finish | stop [dir] --approve <code>
 *
 * Every Flagsmith step is the flagsmith-duel skill's script (skills/flagsmith-duel), so the engine
 * and an agent using the skill do exactly the same thing. Each answer is added to the record.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, AGENT_KEYS, outline } from './agents.ts';
import type { Brief } from './agents.ts';
import { debate, planOf } from './debate.ts';
import type { DuelRecord } from './debate.ts';
import { claude } from './llm.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const SKILL = join(ROOT, 'skills/flagsmith-duel/scripts/duel.mjs');
const STEPS = ['plan', 'approve', 'start', 'audit', 'verdict', 'finish', 'stop'];

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;
const writeJson = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const out = (line = '') => process.stdout.write(line + '\n');
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The brief as written by a person, with the sample pull requests filled in from the scenarios file. */
function loadBrief(dir: string): Brief {
  const raw = readJson<Brief & { scenarios_file?: string }>(join(dir, 'brief.json'));
  const { scenarios } = readJson<{ scenarios: { id: string; title: string; expect: { verdict: string } }[] }>(resolve(dir, raw.scenarios_file ?? join(ROOT, 'examples/scenarios.json')));
  const numbers = raw.facts.statements.flatMap(s => s.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  const { scenarios_file: _, ...brief } = raw;
  return {
    ...brief,
    facts: {
      statements: raw.facts.statements,
      numbers: [...new Set(numbers)],
      scenarios: scenarios.map(s => s.id),
      scenarioTitles: Object.fromEntries(scenarios.map(s => [s.id, `${s.title} (the guard's verdict: ${s.expect.verdict})`])),
    },
  };
}

function show(record: DuelRecord): void {
  out(`${record.name}`);
  out(`Goal: ${record.brief.goal}`);
  out(`Measured: ${record.brief.event.key}. Flag ${record.brief.flag} in ${record.brief.environment}.`);
  for (const k of AGENT_KEYS) {
    const a = AGENTS[k];
    out();
    out(`${a.name} (${a.stance.toLowerCase()})`);
    const p = record.proposals[k];
    if (!p?.screen) { out(`  Forfeits: the referee rejected its screen. ${p?.referee.map(x => x.message).join(' ')}`); continue; }
    out(`  Proposed:  ${outline(p.screen)}`);
    if (p.repaired) out('             (after one rejection by the referee)');
    for (const line of record.attacks[k === 'agent_a' ? 'agent_b' : 'agent_a']?.attacks ?? []) out(`  Attacked:  ${line}`);
    const r = record.revisions[k];
    if (r) out(`  Revision:  ${r.changed}`);
    const f = record.finalists[k];
    if (f) {
      out(`  Enters:    ${outline(f.screen)}`);
      out(`  Claims:    ${f.hypothesis}`);
      if (f.predicts) out(`  Predicts:  today ${pct(f.predicts.control)}, Agent A ${pct(f.predicts.agent_a)}, Agent B ${pct(f.predicts.agent_b)}`);
    }
  }
  out();
  out(`${record.usage.calls} model calls, ${record.usage.seconds} s, ${record.usage.tokens.in + record.usage.tokens.out} tokens (${record.model}).`);
  for (const s of record.steps) out(`${s.at.slice(0, 16).replace('T', ' ')}  ${s.step}: ${summary(s.line)}`);
}

function summary(line: Record<string, unknown>): string {
  if (line.error) return String(line.error);
  if (line.drift) return `seal broken: ${(line.drift as string[]).join('; ')}`;
  if (line.why) return `${line.state}: ${line.why}`;
  if (line.state === 'collecting') return `collecting: ${JSON.stringify(line.visitors)} of ${line.need} per arm${line.counted_at ? `, counted at ${String(line.counted_at).slice(11, 19)} UTC` : ''}`;
  if (line.will) return `would ${(line.will as string[]).join(', ')}`;
  if (line.served) return `experiment ${line.experiment} is ${line.status}; test identities got ${JSON.stringify(line.served)}`;
  if (line.serving) return `${line.status}; ${line.checked}`;
  if (line.sealed) return `sealed, ${line.status}`;
  if (line.approved !== undefined) return line.approved ? `${line.approved} approved, code ${line.code}` : 'refused';
  return JSON.stringify(line);
}

/** Runs one step of the skill's script on this duel's plan and adds its answer to the record. */
function step(dir: string, name: string, args: string[]): number {
  const plan = join(dir, 'duel.json');
  const interactive = name === 'approve';
  const run = spawnSync(process.execPath, [SKILL, name, plan, ...args], { encoding: 'utf8', stdio: [interactive ? 'inherit' : 'ignore', 'pipe', 'inherit'] });
  const text = run.stdout.trim();
  let line: Record<string, unknown>;
  try { line = JSON.parse(text) as Record<string, unknown>; } catch { out(text); return run.status ?? 1; }
  const recordPath = join(dir, 'record.json');
  if (existsSync(recordPath)) {
    const record = readJson<DuelRecord>(recordPath);
    record.steps.push({ at: new Date().toISOString(), step: name, line });
    writeJson(recordPath, record);
  }
  out(`${name}: ${summary(line)}`);
  if (line.approve && name === 'plan') out(`A person decides the start. In your own terminal: npm run duel -- approve start`);
  if (line.approve && name === 'verdict') out(`A person decides the rollout. In your own terminal: npm run duel -- approve finish`);
  if (line.next) out(`next: ${line.next}`);
  return run.status ?? 1;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const [command = 'show', ...rest] = argv;
  let model = process.env.DUEL_MODEL ?? 'sonnet';
  let again = false;
  const words: string[] = []; // the duel's directory, and the step `approve` is for
  const passed: string[] = []; // flags that go to the skill's script
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--model') model = rest[++i] ?? model;
    else if (a === '--again') again = true;
    else if (a === '--approve') passed.push(a, rest[++i] ?? '');
    else if (a.startsWith('--')) passed.push(a);
    else words.push(a);
  }
  // `approve` takes the step as its word; everything else takes the duel's directory.
  const dirArg = words.find(w => !['start', 'finish', 'stop'].includes(w));
  const dir = resolve(dirArg ?? join(ROOT, 'duels/first-screen'));
  const recordPath = join(dir, 'record.json');

  if (command === 'debate') {
    if (existsSync(join(dir, 'duel.seal.json'))) throw new Error('This duel has started. Its record is closed; a new duel needs a new directory.');
    if (existsSync(recordPath) && !again) throw new Error(`${recordPath} exists. Pass --again to run the agents again and replace it.`);
    const brief = loadBrief(dir);
    const record = await debate(claude(model), brief, model, out);
    writeJson(recordPath, record);
    const finalists = AGENT_KEYS.filter(k => record.finalists[k]);
    out();
    show(record);
    if (finalists.length === 0) { out('\nBoth agents forfeited, so there is nothing to test.'); process.exitCode = 1; return; }
    writeJson(join(dir, 'duel.json'), planOf(record, Number(process.env.FLAGSMITH_PROJECT) || undefined));
    out();
    process.exitCode = step(dir, 'plan', []);
    return;
  }
  if (command === 'show') { show(readJson<DuelRecord>(recordPath)); return; }
  if (STEPS.includes(command)) {
    process.exitCode = step(dir, command, [...words.filter(w => ['start', 'finish', 'stop'].includes(w)), ...passed]);
    return;
  }
  throw new Error(`Unknown command "${command}". One of: debate, show, ${STEPS.join(', ')}.`);
}
