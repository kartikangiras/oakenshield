/*
 * The language model behind the two agents: the Claude CLI in print mode, with no tools, no
 * settings and no session, so an agent can only answer with text. It never holds a Flagsmith key.
 */
import { spawn } from 'node:child_process';

export interface Reply {
  text: string;
  /** Wall-clock time of the call. */
  ms: number;
  tokens: { in: number; out: number };
  /** What the call would cost at API prices, as the CLI reports it. */
  cost: number;
}
export type Ask = (system: string, prompt: string) => Promise<Reply>;

const TIMEOUT_MS = 240_000;

export function claude(model: string): Ask {
  return (system, prompt) => new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.env.CLAUDE_BIN ?? 'claude', [
      '-p', '--model', model, '--system-prompt', system, '--tools', '', '--strict-mcp-config',
      '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands',
      '--output-format', 'json', prompt,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); reject(new Error(`Could not run the Claude CLI: ${e.message}`)); });
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(out);
        if (r.is_error) throw new Error(String(r.result));
        const u = r.usage ?? {};
        resolve({
          text: String(r.result ?? ''),
          ms: Date.now() - started,
          tokens: { in: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0), out: u.output_tokens ?? 0 },
          cost: r.total_cost_usd ?? 0,
        });
      } catch (e) {
        reject(new Error(`The model call failed: ${(e as Error).message || err.trim().split('\n')[0] || 'no output'}`));
      }
    });
  });
}

/** The first JSON object in a model's answer, which may be wrapped in a code fence or a sentence. */
export function jsonIn(text: string): unknown {
  const start = text.indexOf('{');
  for (let end = text.lastIndexOf('}'); start >= 0 && end > start; end = text.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* try a shorter slice */ }
  }
  return null;
}
