import { execFileSync } from 'node:child_process';
import {
  demoSnapshot, readSnapshot, scanLine, type GuardConfig, type LiveExperiment, type Snapshot,
} from '@oakenshield/guard';
import type { CodeReference } from './api-types.ts';

/** Where the demo's other repos reference their flags, for the experiment detail view. */
const DEMO_REFERENCES: Record<string, CodeReference[]> = {
  mentor_match: [
    { path: 'src/mentors/MentorPage.tsx', line: 14, text: "const flag = useExperiment('mentor_match');", kind: 'exposure' },
    { path: 'src/mentors/MentorPage.tsx', line: 31, text: "if (flag?.variant === 'match_quiz') return <MatchQuiz mentors={mentors} />;", kind: 'variant' },
    { path: 'src/mentors/MentorCard.tsx', line: 48, text: "flagsmith.trackEvent('mentor_requested');", kind: 'conversion' },
    { path: 'src/mentors/MatchQuiz.tsx', line: 62, text: "flagsmith.trackEvent('mentor_requested');", kind: 'conversion' },
  ],
  search_ranking: [
    { path: 'src/search/rank.ts', line: 22, text: "const flag = await flagsmith.getExperimentFlag('search_ranking', userId);", kind: 'exposure' },
    { path: 'src/search/rank.ts', line: 25, text: "case 'semantic':", kind: 'variant' },
    { path: 'src/search/rank.ts', line: 27, text: "case 'hybrid':", kind: 'variant' },
    { path: 'src/search/Results.tsx', line: 33, text: "flagsmith.trackEvent('result_clicked');", kind: 'conversion' },
    { path: 'src/search/SearchBox.tsx', line: 51, text: "flagsmith.trackEvent('search_refined');", kind: 'conversion' },
  ],
  digest_prompt: [
    { path: 'app/components/DigestPrompt.tsx', line: 6, text: "const flag = useExperiment('digest_prompt');", kind: 'exposure' },
  ],
};

export class ExperimentService {
  readonly mode: 'demo' | 'live';
  readonly config: GuardConfig;
  readonly repoPath?: string;
  readonly demoFiles: Record<string, string>;
  snapshot: Snapshot | null = null;
  error?: string;
  /** Demo mode only: changes the simulate buttons make to the bundled experiments. */
  private demoPatches = new Map<string, Partial<LiveExperiment>>();

  constructor(opts: { mode: 'demo' | 'live'; config: GuardConfig; repoPath?: string; demoFiles?: Record<string, string> }) {
    this.mode = opts.mode;
    this.config = opts.config;
    this.repoPath = opts.repoPath;
    this.demoFiles = opts.demoFiles ?? {};
  }

  async refresh(): Promise<Snapshot | null> {
    try {
      this.snapshot = this.mode === 'demo' ? this.patchedDemo() : await readSnapshot({ config: this.config, log: m => console.warn(`[flagsmith] ${m}`) });
      this.error = undefined;
    } catch (err) {
      this.error = (err as Error).message;
      console.warn(`[flagsmith] snapshot failed: ${this.error}`);
    }
    return this.snapshot;
  }

  private patchedDemo(): Snapshot {
    const snap = demoSnapshot();
    snap.experiments = snap.experiments.map(e => ({ ...e, ...this.demoPatches.get(String(e.id)) }));
    return snap;
  }

  /** Demo mode: change a bundled experiment (status, dates, audience) as if it changed in Flagsmith. */
  patchDemo(id: string | number, patch: Partial<LiveExperiment>) {
    if (this.mode !== 'demo') throw new Error('Only the demo snapshot can be patched');
    this.demoPatches.set(String(id), { ...this.demoPatches.get(String(id)), ...patch });
  }

  resetDemo() {
    this.demoPatches.clear();
  }

  get experiments(): LiveExperiment[] {
    return this.snapshot?.experiments ?? [];
  }

  get running(): LiveExperiment[] {
    return this.experiments.filter(e => e.status === 'running');
  }

  references(exp: LiveExperiment): CodeReference[] {
    const literals = [exp.flagKey, ...exp.metricEvents, ...exp.variationKeys];
    const kindOf = (path: string, line: number, text: string): CodeReference['kind'] => {
      const s = scanLine(path, line, text, 'head');
      if (s.hits.some(h => h.kind === 'exposure' && h.value === exp.flagKey)) return 'exposure';
      if (s.hits.some(h => h.kind === 'conversion' && exp.metricEvents.includes(h.value))) return 'conversion';
      if (s.hits.some(h => h.kind === 'variant' && exp.variationKeys.includes(h.value))) return 'variant';
      return 'reference';
    };
    const quoted = (text: string) => literals.some(l => text.includes(`'${l}'`) || text.includes(`"${l}"`) || text.includes(`\`${l}\``));

    if (this.mode === 'demo') {
      if (DEMO_REFERENCES[exp.flagKey]) return DEMO_REFERENCES[exp.flagKey];
      const out: CodeReference[] = [];
      for (const [path, content] of Object.entries(this.demoFiles)) {
        if (!/\.(tsx?|jsx?|py)$/.test(path)) continue;
        content.split('\n').forEach((text, i) => {
          if (quoted(text)) out.push({ path, line: i + 1, text: text.trim(), kind: kindOf(path, i + 1, text) });
        });
      }
      return out;
    }
    if (!this.repoPath) return [];
    try {
      const args = ['grep', '-n', '-I', '-F', '--full-name'];
      for (const l of literals) args.push('-e', l);
      const out = execFileSync('git', [...args, 'HEAD', '--'], { cwd: this.repoPath, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      return out.split('\n').filter(Boolean).flatMap(raw => {
        const m = raw.replace(/^HEAD:/, '').match(/^(.*?):(\d+):(.*)$/);
        if (!m || !quoted(m[3])) return [];
        return [{ path: m[1], line: Number(m[2]), text: m[3].trim(), kind: kindOf(m[1], Number(m[2]), m[3]) }];
      });
    } catch {
      return [];
    }
  }
}
