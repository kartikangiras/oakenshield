import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny } from './glob.ts';
import type { RuleId, SeveritySetting } from './types.ts';
import { parseYaml, type YamlValue } from './yaml.ts';

export const RULE_IDS: RuleId[] = [
  'EG001', 'EG002', 'EG003', 'EG004', 'EG005', 'EG006', 'EG007', 'EG008', 'EG009', 'EG010', 'EG011', 'EG012', 'EG013',
];

export interface GuardConfig {
  version: 1;
  flagsmith: {
    apiUrl: string;
    project?: string;
    environment?: string;
    auth: 'oidc' | 'api_key' | 'cli' | 'none';
    failOpen: boolean;
    snapshotFile?: string;
  };
  scan: {
    include: string[];
    exclude: string[];
  };
  rules: Partial<Record<RuleId, SeveritySetting>>;
  override: {
    label: string;
    minPermission: 'write' | 'maintain' | 'admin';
  };
  ai: {
    enabled: boolean;
    modelEnv: string;
    keyEnv: string;
    maxFindings: number;
    redactSecrets: boolean;
  };
  identityPatterns: string[];
  /** Your own functions that wrap the SDK, read the same way as getExperimentFlag and trackEvent. */
  calls: {
    exposure: string[];
    conversion: string[];
  };
  report: {
    url?: string;
  };
}

export const DEFAULT_EXCLUDE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**',
  '**/*.test.*', '**/*.spec.*', '**/__tests__/**', '**/test/**', '**/tests/**',
  'docs/**', '**/*.md', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock',
  '.experiment-guard/**',
];

/** Manifests are scanned even when a user's include globs would skip them. */
const ALWAYS_SCAN = /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.cfg|go\.mod|build\.gradle(\.kts)?|pom\.xml|pubspec\.yaml)$/;

/** Is this path part of the code the guard reads (scan.include minus scan.exclude)? */
export function inScope(path: string, config: GuardConfig): boolean {
  if (ALWAYS_SCAN.test(path)) return true;
  return matchesAny(path, config.scan.include) && !matchesAny(path, config.scan.exclude);
}

export function defaultConfig(): GuardConfig {
  return {
    version: 1,
    flagsmith: { apiUrl: 'https://api.flagsmith.com', auth: 'oidc', failOpen: true },
    scan: { include: ['**'], exclude: [...DEFAULT_EXCLUDE] },
    rules: {},
    override: { label: 'experiment-guard:override', minPermission: 'maintain' },
    ai: { enabled: false, modelEnv: 'GUARD_AI_MODEL', keyEnv: 'GUARD_AI_KEY', maxFindings: 5, redactSecrets: true },
    identityPatterns: [],
    calls: { exposure: [], conversion: [] },
    report: {},
  };
}

export const CONFIG_FILES = ['.experiment-guard.yml', '.experiment-guard.yaml', '.experiment-guard.json'];

export class ConfigError extends Error {}

type Obj = { [key: string]: YamlValue };

function obj(v: YamlValue | undefined, where: string): Obj {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new ConfigError(`${where} must be a map`);
  return v;
}

function str(v: YamlValue | undefined, where: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  throw new ConfigError(`${where} must be a string`);
}

function bool(v: YamlValue | undefined, where: string, fallback: boolean): boolean {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  throw new ConfigError(`${where} must be true or false`);
}

function list(v: YamlValue | undefined, where: string): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new ConfigError(`${where} must be a list`);
  return v.map((x, i) => {
    if (typeof x !== 'string') throw new ConfigError(`${where}[${i}] must be a string`);
    return x;
  });
}

/** Builds a validated config from parsed YAML/JSON. Unknown keys produce warnings, not errors. */
export function normalizeConfig(raw: YamlValue): { config: GuardConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config = defaultConfig();
  const root = obj(raw, 'config');
  const known = new Set(['version', 'flagsmith', 'scan', 'rules', 'override', 'ai', 'identity_patterns', 'calls', 'report']);
  for (const k of Object.keys(root)) if (!known.has(k)) warnings.push(`Unknown top-level key "${k}" ignored`);

  if (root.version !== undefined && root.version !== 1) throw new ConfigError('version must be 1');

  const fs = obj(root.flagsmith, 'flagsmith');
  config.flagsmith.apiUrl = (str(fs.api_url, 'flagsmith.api_url') ?? config.flagsmith.apiUrl).replace(/\/+$/, '');
  config.flagsmith.project = str(fs.project, 'flagsmith.project');
  config.flagsmith.environment = str(fs.environment, 'flagsmith.environment');
  const auth = str(fs.auth, 'flagsmith.auth') ?? config.flagsmith.auth;
  if (!['oidc', 'api_key', 'cli', 'none'].includes(auth)) throw new ConfigError('flagsmith.auth must be oidc, api_key, cli or none');
  config.flagsmith.auth = auth as GuardConfig['flagsmith']['auth'];
  config.flagsmith.failOpen = bool(fs.fail_open, 'flagsmith.fail_open', true);
  config.flagsmith.snapshotFile = str(fs.snapshot_file, 'flagsmith.snapshot_file');

  const scan = obj(root.scan, 'scan');
  config.scan.include = list(scan.include, 'scan.include') ?? config.scan.include;
  const extraExclude = list(scan.exclude, 'scan.exclude');
  if (extraExclude) config.scan.exclude = [...DEFAULT_EXCLUDE, ...extraExclude];

  const rules = obj(root.rules, 'rules');
  for (const [id, sev] of Object.entries(rules)) {
    if (!RULE_IDS.includes(id as RuleId)) { warnings.push(`Unknown rule "${id}" ignored`); continue; }
    if (typeof sev !== 'string' || !['block', 'warn', 'info', 'off'].includes(sev)) {
      throw new ConfigError(`rules.${id} must be block, warn, info or off`);
    }
    config.rules[id as RuleId] = sev as SeveritySetting;
  }

  const ov = obj(root.override, 'override');
  config.override.label = str(ov.label, 'override.label') ?? config.override.label;
  const perm = str(ov.min_permission, 'override.min_permission') ?? config.override.minPermission;
  if (!['write', 'maintain', 'admin'].includes(perm)) throw new ConfigError('override.min_permission must be write, maintain or admin');
  config.override.minPermission = perm as GuardConfig['override']['minPermission'];

  const ai = obj(root.ai, 'ai');
  config.ai.enabled = bool(ai.enabled, 'ai.enabled', false);
  config.ai.modelEnv = str(ai.model_env, 'ai.model_env') ?? config.ai.modelEnv;
  config.ai.keyEnv = str(ai.key_env, 'ai.key_env') ?? config.ai.keyEnv;
  const max = ai.max_findings ?? ai.max_hunks;
  if (typeof max === 'number') config.ai.maxFindings = max;
  config.ai.redactSecrets = bool(ai.redact_secrets, 'ai.redact_secrets', true);

  config.identityPatterns = list(root.identity_patterns, 'identity_patterns') ?? [];

  const calls = obj(root.calls, 'calls');
  for (const kind of ['exposure', 'conversion'] as const) {
    const names = list(calls[kind], `calls.${kind}`) ?? [];
    for (const n of names) {
      if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(n)) throw new ConfigError(`calls.${kind} must list function names such as track or analytics.track, got "${n}"`);
    }
    config.calls[kind] = names;
  }

  const rep = obj(root.report, 'report');
  config.report.url = str(rep.url, 'report.url');

  return { config, warnings };
}

export function parseConfigText(text: string, fileName = '.experiment-guard.yml') {
  const raw = fileName.endsWith('.json') ? (JSON.parse(text) as YamlValue) : parseYaml(text);
  return normalizeConfig(raw);
}

export function loadConfig(cwd: string, explicitPath?: string): { config: GuardConfig; path: string | null; warnings: string[] } {
  const candidates = explicitPath ? [explicitPath] : CONFIG_FILES.map(f => join(cwd, f));
  for (const p of candidates) {
    if (existsSync(p)) {
      const { config, warnings } = parseConfigText(readFileSync(p, 'utf8'), p);
      return { config, path: p, warnings };
    }
  }
  if (explicitPath) throw new ConfigError(`Config file not found: ${explicitPath}`);
  return { config: defaultConfig(), path: null, warnings: [] };
}
