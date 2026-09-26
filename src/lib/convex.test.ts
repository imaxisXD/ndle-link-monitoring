import { describe, expect, test } from 'bun:test';

// The integration suite replaces the Convex module for the whole test run.
if (!process.env.MONITOR_TEST_DATABASE_URL && !process.env.MONITOR_TEST_REDIS_URL) {
describe('Convex delivery requests', async () => {
  const { CONVEX_REQUEST_TIMEOUT_MS, withRequestTimeout } = await import('./convex');

  test('a hung request is aborted by its own deadline', async () => {
    const hung = ((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as typeof fetch;
    const started = Date.now();
    const error = await withRequestTimeout(hung, 30)('https://example.convex.cloud/api/mutation', { method: 'POST' }).catch(caught => caught);
    expect(error.name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('requests keep their options and any caller signal', async () => {
    let seen: RequestInit | undefined;
    const record = (async (_input: string | URL | Request, init?: RequestInit) => { seen = init; return new Response('{}'); }) as typeof fetch;
    const caller = new AbortController();
    await withRequestTimeout(record)('https://example.convex.cloud/api/mutation', { method: 'POST', body: '{}', signal: caller.signal });
    expect(seen?.method).toBe('POST');
    expect(seen?.body).toBe('{}');
    expect(seen?.signal?.aborted).toBe(false);
    caller.abort();
    expect(seen?.signal?.aborted).toBe(true);
    expect(CONVEX_REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});
} else { test.skip('Convex request tests run only in the offline suite', () => {}); }
