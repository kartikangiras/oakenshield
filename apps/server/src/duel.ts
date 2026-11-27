import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DuelView } from './api-types.ts';

const read = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/**
 * The agent duel as it is on disk: the record the duel CLI wrote, and the seal, verdict and
 * approvals the flagsmith-duel skill wrote beside the plan. Read on every request, so the page
 * follows the files. Null until a duel has been run.
 */
export function readDuel(dir: string | undefined): DuelView | null {
  if (!dir || !existsSync(join(dir, 'record.json'))) return null;
  return {
    record: read(join(dir, 'record.json')),
    seal: read(join(dir, 'duel.seal.json')),
    verdict: read(join(dir, 'duel.verdict.json')),
    approvals: read(join(dir, 'duel.approvals.json')),
    // The simulated visitors' own summary: personas.mjs --out <dir>/traffic
    traffic: read(join(dir, 'traffic', 'summary.json')),
    // and the same run one visitor at a time, for the animation (scripts/traffic/replay.mjs)
    replay: read(join(dir, 'traffic', 'replay.json')),
  };
}
