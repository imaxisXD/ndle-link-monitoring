import { describe, expect, test } from 'bun:test';
import pino from 'pino';
import { checkUrl } from './checker';
import type { ResolveHost } from './url-safety';

const silent = pino({ level: 'silent' });

// The integration suite replaces the checker module for the whole test run.
if (!process.env.MONITOR_TEST_DATABASE_URL && !process.env.MONITOR_TEST_REDIS_URL) {
describe('destination checks without network access', () => {
  test('a domain that does not resolve is recorded as down', async () => {
    for (const code of ['ENOTFOUND', 'EAI_NONAME']) {
      const unresolved: ResolveHost = async hostname => {
        throw Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), { code });
      };
      expect(await checkUrl('https://expired-domain.invalid/offer', silent, unresolved)).toMatchObject({
        statusCode: 0, isHealthy: false, healthStatus: 'down', errorMessage: 'Domain does not resolve',
      });
    }
  });

  test('a destination that resolves to a private address is recorded without the address', async () => {
    for (const record of [{ address: '10.20.30.40', family: 4 }, { address: '::ffff:a14:1e28', family: 6 }]) {
      const result = await checkUrl('https://internal.example/', silent, async () => [record]);
      expect(result).toMatchObject({ statusCode: 0, isHealthy: false, healthStatus: 'down' });
      expect(result.errorMessage).toBe('URL resolves to a private network address');
      expect(result.errorMessage).not.toContain(record.address);
    }
  });
});
} else { test.skip('destination check results are covered by the offline suite', () => {}); }
