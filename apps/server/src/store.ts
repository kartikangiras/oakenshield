import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CheckRecord, CheckSummary, FlagsmithAlert, Settings } from './api-types.ts';

export interface StoreData {
  version: 1;
  seededAt?: string;
  checks: CheckRecord[];   // newest first
  alerts?: FlagsmithAlert[]; // newest first
  settings: Settings;
}

export const DEFAULT_SETTINGS: Settings = { hoursPerBlock: 6, ruleSeverity: {} };
const MAX_CHECKS = 5000;
const MAX_ALERTS = 300;

export function summarize(c: CheckRecord): CheckSummary {
  const { findings, markdown: _m, diff: _d, ...rest } = c;
  return {
    ...rest,
    rules: [...new Set(findings.filter(f => !f.ignoredBecause).map(f => f.rule))],
    findingsCount: findings.length,
  };
}

/** A JSON-file store: everything in memory, written atomically shortly after each change. */
export class Store {
  readonly path: string | null;
  data: StoreData;
  private timer: NodeJS.Timeout | null = null;

  constructor(path: string | null) {
    this.path = path;
    this.data = { version: 1, checks: [], settings: structuredClone(DEFAULT_SETTINGS) };
    if (path && existsSync(path)) {
      try {
        const loaded = JSON.parse(readFileSync(path, 'utf8')) as StoreData;
        this.data = { ...this.data, ...loaded, settings: { ...DEFAULT_SETTINGS, ...loaded.settings } };
      } catch (err) {
        console.warn(`[store] could not read ${path}: ${(err as Error).message}. Starting empty.`);
      }
    }
  }

  get checks(): CheckRecord[] {
    return this.data.checks;
  }

  get alerts(): FlagsmithAlert[] {
    return this.data.alerts ?? [];
  }

  addAlert(a: FlagsmithAlert) {
    this.data.alerts = [a, ...this.alerts].slice(0, MAX_ALERTS);
    this.save();
  }

  addCheck(c: CheckRecord) {
    this.data.checks.unshift(c);
    if (this.data.checks.length > MAX_CHECKS) this.data.checks.length = MAX_CHECKS;
    this.save();
  }

  replaceChecks(checks: CheckRecord[], seededAt: string) {
    this.data.checks = [...checks].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    this.data.seededAt = seededAt;
    this.save();
  }

  getCheck(id: string): CheckRecord | undefined {
    return this.data.checks.find(c => c.id === id);
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch, ruleSeverity: { ...this.data.settings.ruleSeverity, ...patch.ruleSeverity } };
    this.save();
    return this.data.settings;
  }

  save() {
    if (!this.path) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 150);
  }

  flush() {
    if (!this.path) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.path);
  }
}
