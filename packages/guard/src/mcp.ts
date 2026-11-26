import { createInterface } from 'node:readline';
import type { GuardConfig } from './config.ts';
import { runCheck } from './engine.ts';
import { readSnapshot } from './flagsmith.ts';
import { DiffOnlyRepoView, GitRepoView } from './repo.ts';
import { RULES_BY_ID } from './rules/catalog.ts';
import type { RuleId, Snapshot } from './types.ts';
import { VERSION } from './version.ts';

/*
 * A minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), so coding
 * agents can check a change before it becomes a PR. All tools are read-only.
 */

const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const TOOLS = [
  {
    name: 'list_protected_experiments',
    description: 'List running Flagsmith experiments with their flag key, variation keys, metric events, audience segment traits and the files that reference them.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'check_experiment_impact',
    description: 'Check whether a code change would corrupt a running Flagsmith experiment. Defaults to the working tree against HEAD. Returns verdict and findings.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base git ref (default HEAD)' },
        head: { type: 'string', description: 'Head git ref, or WORKTREE for uncommitted changes (default WORKTREE)' },
        diff: { type: 'string', description: 'A unified diff to check instead of git refs' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'explain_rule',
    description: 'Explain an Experiment Guard rule (EG001 to EG013) and how to fix it.',
    inputSchema: { type: 'object', properties: { rule: { type: 'string' } }, required: ['rule'], additionalProperties: false },
  },
];

type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface McpOptions {
  cwd: string;
  config: GuardConfig;
  snapshotFile?: string;
  demo?: boolean;
}

export async function handleMcpRequest(msg: Json, opts: McpOptions, cache: { snapshot?: Snapshot }): Promise<Json | null> {
  const { id, method, params } = msg ?? {};
  const reply = (result: Json) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined || id === null) return null; // notification

  const snapshot = async () => (cache.snapshot ??= await readSnapshot({ config: opts.config, file: opts.snapshotFile, demo: opts.demo }));
  const text = (value: unknown, isError = false) => reply({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], isError });

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        return reply({
          protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'experiment-guard', version: VERSION },
          instructions: 'Call check_experiment_impact before committing changes to files that call getExperimentFlag, useExperiment or trackEvent. If the verdict is "block", do not commit.',
        });
      }
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments ?? {};
        if (name === 'explain_rule') {
          const meta = RULES_BY_ID[String(args.rule).toUpperCase() as RuleId];
          return meta ? text(meta) : text(`Unknown rule ${args.rule}`, true);
        }
        if (name === 'list_protected_experiments') {
          const snap = await snapshot();
          const running = snap.experiments.filter(e => e.status === 'running');
          const repo = new GitRepoView({ cwd: opts.cwd, base: 'HEAD', head: 'WORKTREE' });
          const result = running.map(e => {
            const traits = (e.audience ?? []).flatMap(a => a.traits);
            const literals = [e.flagKey, ...e.metricEvents, ...e.variationKeys, ...traits];
            let references: Array<{ path: string; line: number }> = [];
            try { references = repo.grep('head', literals).map(h => ({ path: h.path, line: h.line })); } catch { /* not a git repo */ }
            const audience = (e.audience ?? []).map(a => ({ segment: a.name, traits: a.traits }));
            return { id: e.id, name: e.name, flagKey: e.flagKey, variationKeys: e.variationKeys, metricEvents: e.metricEvents, audience, references };
          });
          return text(result);
        }
        if (name === 'check_experiment_impact') {
          const snap = await snapshot();
          const repo = args.diff
            ? new DiffOnlyRepoView(String(args.diff))
            : new GitRepoView({ cwd: opts.cwd, base: args.base ?? 'HEAD', head: args.head ?? 'WORKTREE' });
          const report = runCheck({ repo, snapshot: snap, config: opts.config, meta: { source: 'mcp' } });
          return text(report);
        }
        return fail(-32602, `Unknown tool: ${name}`);
      }
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return text(`Experiment Guard error: ${(err as Error).message}`, true);
  }
}

export async function serveMcp(opts: McpOptions): Promise<void> {
  const cache: { snapshot?: Snapshot } = {};
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const res = await handleMcpRequest(msg, opts, cache);
    if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
  }
}
