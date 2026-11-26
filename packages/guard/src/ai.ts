import type { GuardConfig } from './config.ts';
import type { Report } from './types.ts';

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ser\.[A-Za-z0-9]{16,}|xox[abp]-[A-Za-z0-9-]{10,})\b/g;

export function redact(text: string): string {
  return text.replace(SECRET_RE, '[redacted]');
}

export function buildPrompt(report: Report, max: number): { prompt: string; ids: string[] } | null {
  const warnings = report.findings.filter(f => f.severity === 'warn' && !f.ignoredBecause).slice(0, max);
  if (warnings.length === 0) return null;
  const items = warnings.map((f, i) => [
    `#${i + 1} id=${f.id} rule=${f.rule} (${f.title})`,
    `experiment: ${f.experimentName ?? 'unknown'} flag=${f.flagKey ?? 'n/a'}`,
    `location: ${f.file}:${f.line}`,
    `change:\n${redact(f.evidence)}`,
    `known consequence: ${f.consequence}`,
  ].join('\n'));
  const prompt = [
    'You review pull requests for a team running Flagsmith A/B experiments.',
    'For each warning below, write ONE plain sentence (max 30 words) telling the reviewer what to check before merging.',
    'Do not change the severity and do not compute statistics.',
    'Answer as JSON: {"notes": [{"id": "<id>", "note": "<sentence>"}]}',
    '',
    ...items,
  ].join('\n');
  return { prompt, ids: warnings.map(w => w.id) };
}

/**
 * Optional: asks an AI model to add a reviewer note to each warning.
 * Never changes severity or verdict. Any failure leaves the report as it was.
 */
export async function explainWarnings(report: Report, config: GuardConfig, env: NodeJS.ProcessEnv = process.env): Promise<Report> {
  const key = env[config.ai.keyEnv];
  const model = env[config.ai.modelEnv];
  if (!config.ai.enabled || !key || !model) return report;
  const built = buildPrompt(report, config.ai.maxFindings);
  if (!built) return report;
  try {
    const res = await fetch(env.GUARD_AI_URL ?? 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: 'user', content: built.prompt }] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return report;
    const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
    const text = data.content?.find(c => c.type === 'text')?.text ?? '';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as { notes?: Array<{ id: string; note: string }> };
    const notes = new Map((json.notes ?? []).map(n => [n.id, n.note]));
    return { ...report, findings: report.findings.map(f => (notes.has(f.id) ? { ...f, aiNote: notes.get(f.id) } : f)) };
  } catch {
    return report;
  }
}
