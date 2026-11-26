import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigText, type GuardConfig } from './config.ts';
import { MemoryRepoView } from './repo.ts';
import type { RuleId, Verdict } from './types.ts';

/*
 * Scenarios are scripted PRs against the bundled FirstPR demo app. They power
 * the tests, `experiment-guard demo`, and the dashboard playground.
 */

export type Edit =
  | { path: string; find: string; replace: string }
  | { path: string; content: string }
  | { path: string; delete: true }
  | { path: string; moveTo: string };

export interface Scenario {
  id: string;
  title: string;
  prTitle?: string;
  description: string;
  author?: string;
  negative?: boolean;
  expect: { verdict: Verdict; rules: RuleId[] };
  edits: Edit[];
}

export interface ScenarioSet {
  root: string;
  baseFiles: Record<string, string>;
  config: GuardConfig;
  scenarios: Scenario[];
}

export const EXAMPLES_DIR = fileURLToPath(new URL('../../../examples/', import.meta.url));

function readTree(dir: string, root = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) readTree(abs, root, out);
    else out[relative(root, abs).split('\\').join('/')] = readFileSync(abs, 'utf8');
  }
  return out;
}

export function loadScenarioSet(examplesDir = EXAMPLES_DIR): ScenarioSet {
  const def = JSON.parse(readFileSync(join(examplesDir, 'scenarios.json'), 'utf8')) as { app: string; scenarios: Scenario[] };
  const root = join(examplesDir, def.app);
  const baseFiles = readTree(root);
  const cfgPath = join(root, '.experiment-guard.yml');
  const config = existsSync(cfgPath) ? parseConfigText(readFileSync(cfgPath, 'utf8')).config : parseConfigText('version: 1').config;
  return { root, baseFiles, config, scenarios: def.scenarios };
}

export class ScenarioError extends Error {}

export function applyEdits(base: Record<string, string>, edits: Edit[]): Record<string, string> {
  const head = { ...base };
  for (const e of edits) {
    if ('delete' in e) { delete head[e.path]; continue; }
    if ('moveTo' in e) {
      if (head[e.path] === undefined) throw new ScenarioError(`Cannot move missing file ${e.path}`);
      head[e.moveTo] = head[e.path];
      delete head[e.path];
      continue;
    }
    if ('content' in e) { head[e.path] = e.content; continue; }
    const cur = head[e.path];
    if (cur === undefined) throw new ScenarioError(`Cannot edit missing file ${e.path}`);
    if (!cur.includes(e.find)) throw new ScenarioError(`Edit for ${e.path} did not match: ${JSON.stringify(e.find.slice(0, 60))}`);
    head[e.path] = cur.replace(e.find, e.replace);
  }
  return head;
}

export function scenarioRepo(set: ScenarioSet, scenario: Scenario): MemoryRepoView {
  return new MemoryRepoView(set.baseFiles, applyEdits(set.baseFiles, scenario.edits));
}
