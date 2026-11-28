import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArenaView } from './api-types.ts';

const read = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

/** The loss limit as the brief beside the record states it. The runner's state carries the one it really trades under. */
function limitOf(brief: unknown): ArenaView['limit'] {
  const risk = (brief as { risk?: { max_loss?: unknown; over?: unknown } } | null)?.risk;
  return risk && typeof risk.max_loss === 'number' && typeof risk.over === 'number' ? { max_loss: risk.max_loss, over: risk.over } : null;
}

const PARTS = ['record', 'seal', 'verdict', 'approvals', 'state', 'check'] as const;

/**
 * The trading arena. Its files are the arena CLI's (record, check), the flagsmith-duel skill's (seal,
 * verdict, approvals) and the runner's (state). The runner trades on another machine than this
 * server, so it also pushes what it has; a pushed part is newer than the copy deployed with the
 * code. Null until an arena exists.
 */
export class Arena {
  private pushed: Partial<Record<(typeof PARTS)[number], unknown>> = {};
  private dir: string | undefined;
  /** When the runner was last heard from. */
  private heard: string | null = null;

  constructor(dir: string | undefined) { this.dir = dir; }

  /** Takes what the runner sent. Unknown keys are dropped, so a push can never add to the view. */
  push(body: unknown): void {
    if (!body || typeof body !== 'object') return;
    this.heard = new Date().toISOString();
    for (const k of PARTS) {
      const v = (body as Record<string, unknown>)[k];
      if (v && typeof v === 'object') this.pushed[k] = v;
    }
  }

  view(): ArenaView | null {
    const disk = (name: string) => (this.dir ? read(join(this.dir, name)) : null);
    const has = this.pushed.record ?? (this.dir && existsSync(join(this.dir, 'record.json')) ? disk('record.json') : null);
    if (!has) return null;
    return {
      record: has,
      seal: this.pushed.seal ?? disk('duel.seal.json'),
      verdict: this.pushed.verdict ?? disk('duel.verdict.json'),
      approvals: this.pushed.approvals ?? disk('duel.approvals.json'),
      state: this.pushed.state ?? disk('state.json'),
      check: this.pushed.check ?? disk('check.json'),
      limit: limitOf(disk('brief.json')),
      heard_at: this.heard,
    };
  }
}
