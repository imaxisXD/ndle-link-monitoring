import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as dns from 'node:dns/promises';

// The integration suite loads the database module against its isolated services, so this suite stays out of its way.
if (!process.env.MONITOR_TEST_DATABASE_URL && !process.env.MONITOR_TEST_REDIS_URL) {
const saved = { DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL, MONITORING_API_SECRET: process.env.MONITORING_API_SECRET };
// Closed local ports: nothing in this suite can reach a real database or Redis.
Object.assign(process.env, { DATABASE_URL: 'postgres://127.0.0.1:1/offline_test', REDIS_URL: 'redis://127.0.0.1:1/15', MONITORING_API_SECRET: 'offline-test' });

describe('monitor registration HTTP contract', async () => {
  const monitorStore = await import('./lib/monitor-store');
  const { createApp, hasValidBearerToken } = await import('./app');
  const register = spyOn(monitorStore, 'registerMonitor').mockImplementation(async input => ({ id: `link-${input.convexUrlId}`, monitoringVersion: input.monitoringVersion ?? 0, isDeleted: false }));
  const lookup = spyOn(dns, 'lookup');
  afterEach(() => { register.mockClear(); lookup.mockClear(); });
  afterAll(() => {
    register.mockRestore(); lookup.mockRestore();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });

  const app = createApp(false, false);
  const request = (path: string, body: unknown) => app.handle(new Request(`http://localhost${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer offline-test' }, body: JSON.stringify(body),
  }));
  const send = (path: string, init: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
  const link = { convexUrlId: 'url-1', convexUserId: 'user-1', shortUrl: 'short', monitoringVersion: 3 };
  const rejectedUrls = [
    'not a url', 'ftp://example.com/file', 'https://user:secret@example.com/', 'http://localhost:3000/', 'http://api.localhost/',
    'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/',
    'https://example.com:8000/', 'http://example.com:5432/',
  ];

  test('public and unresolvable hostnames register without a DNS lookup', async () => {
    for (const longUrl of ['https://Example.com/landing', 'https://expired-domain.invalid/offer']) {
      const response = await request('/monitors/register', { ...link, longUrl });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, linkId: 'link-url-1', monitoringVersion: 3, isDeleted: false });
    }
    expect(register.mock.calls.map(([input]) => input.longUrl)).toEqual(['https://example.com/landing', 'https://expired-domain.invalid/offer']);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a URL that can never be monitored is a 400 invalid_url and is not saved', async () => {
    for (const longUrl of rejectedUrls) {
      const response = await request('/monitors/register', { ...link, longUrl });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({ success: false, code: 'invalid_url', error: expect.any(String) });
      // Short fixed messages: no addresses or credentials are echoed back.
      expect(body.error).not.toMatch(/\d+\.\d+\.\d+\.\d+|::|secret/);
    }
    expect(register).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a batch registers valid links and reports invalid ones per link', async () => {
    const response = await request('/monitors/batch', { links: [
      { ...link, longUrl: 'https://example.com/' },
      { ...link, convexUrlId: 'url-2', longUrl: 'http://10.0.0.5/' },
      { ...link, convexUrlId: 'url-3', longUrl: 'https://expired-domain.invalid/' },
      { ...link, convexUrlId: 'url-4', longUrl: 'ftp://example.com/' },
    ] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true, inserted: 2, rejected: 2,
      results: [
        { convexUrlId: 'url-1', success: true },
        { convexUrlId: 'url-2', success: false, code: 'invalid_url', error: 'URL points to a private network address' },
        { convexUrlId: 'url-3', success: true },
        { convexUrlId: 'url-4', success: false, code: 'invalid_url', error: 'Only HTTP and HTTPS URLs can be monitored' },
      ],
    });
    expect(register.mock.calls.map(([input]) => [input.convexUrlId, input.environment])).toEqual([['url-1', 'prod'], ['url-3', 'prod']]);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('requests without the secret get 401 before the body or parameters are parsed or validated', async () => {
    const unauthenticated: Array<[string, RequestInit]> = [
      ['/monitors/register', { method: 'POST', body: '{}' }],
      ['/monitors/register', { method: 'POST', body: '{"longUrl": 42' }],
      ['/monitors/register', { method: 'POST', body: JSON.stringify({ ...link, longUrl: 'https://example.com/' }) }],
      ['/monitors/batch', { method: 'POST', body: JSON.stringify({ links: 'not a list' }) }],
      ['/monitors/unregister', { method: 'POST', body: '[]' }],
      ['/monitors/not-a-uuid', { method: 'GET' }],
      ['/monitors/not-a-uuid/force-check', { method: 'POST' }],
      ['/monitors/not-a-uuid', { method: 'DELETE' }],
    ];
    for (const authorization of [undefined, '', 'Bearer wrong', 'Bearer offline-tes', 'Bearer offline-test-extra', 'offline-test', 'bearer offline-test', 'Basic b2ZmbGluZS10ZXN0']) {
      for (const [path, init] of unauthenticated) {
        const response = await send(path, { ...init, headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) } });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Access denied' });
      }
    }
    expect(register).not.toHaveBeenCalled();
    expect((await send('/health', { method: 'GET' })).status).toBe(200);
  });

  test('authenticated requests are still validated', async () => {
    const response = await request('/monitors/register', { longUrl: 'https://example.com/' });
    expect(response.status).toBe(422);
    expect(register).not.toHaveBeenCalled();
  });

  test('the bearer secret is compared in constant time', async () => {
    const compare = spyOn(crypto, 'timingSafeEqual');
    try {
      expect(hasValidBearerToken('Bearer offline-test', 'offline-test')).toBe(true);
      for (const header of [null, '', 'Bearer x', 'Bearer offline-tesT', `Bearer ${'offline-test'.repeat(50)}`]) {
        expect(hasValidBearerToken(header, 'offline-test')).toBe(false);
      }
      expect(compare).toHaveBeenCalledTimes(6);
      // Both sides are SHA-256 digests, so their length never depends on the input.
      for (const [actual, expected] of compare.mock.calls) {
        expect(actual.byteLength).toBe(32);
        expect(expected.byteLength).toBe(32);
      }
      compare.mockClear();
      expect((await send('/monitors/not-a-uuid', { headers: { authorization: 'Bearer short' } })).status).toBe(401);
      expect(compare).toHaveBeenCalled();
    } finally { compare.mockRestore(); }
  });

  test('routes are unavailable when the API secret is not configured', async () => {
    delete process.env.MONITORING_API_SECRET;
    try {
      const response = await request('/monitors/register', {});
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Service is not configured' });
    } finally { process.env.MONITORING_API_SECRET = 'offline-test'; }
  });

  test('unexpected storage failures remain server errors', async () => {
    register.mockImplementationOnce(async () => { throw new Error('Invalid URL in connection string'); });
    expect((await request('/monitors/register', { ...link, longUrl: 'https://example.com/' })).status).toBe(500);
    register.mockImplementationOnce(async () => { throw new Error('Database unavailable'); });
    expect((await request('/monitors/batch', { links: [{ ...link, longUrl: 'https://example.com/' }] })).status).toBe(500);
  });
});

} else { test.skip('monitor registration HTTP contract runs only in the offline suite', () => {}); }
