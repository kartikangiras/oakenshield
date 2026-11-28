/* One JSON GET with a timeout and a few retries. Public market data hosts drop connections now and then. */

export class NotFound extends Error {}

export async function getJson<T>(url: string, { tries = 4, timeout = 8000 }: { tries?: number; timeout?: number } = {}): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'oakenshield-arena' }, signal: AbortSignal.timeout(timeout) });
      if (res.status === 404) throw new NotFound(url);
      if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof NotFound) throw e;
      last = e;
      if (i < tries - 1) await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  const cause = (last as { cause?: { code?: string } })?.cause?.code;
  throw new Error(`${new URL(url).host}: ${cause ?? (last as Error)?.message ?? 'no answer'}`);
}
