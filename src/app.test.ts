import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as dns from 'node:dns/promises';
import { createApp, hasValidBearerToken } from './app';
import { serviceState } from './lib/service-state';

const savedSecret = process.env.MONITORING_API_SECRET;
const savedServiceState = { ...serviceState };

describe('monitor registration HTTP contract', () => {
  process.env.MONITORING_API_SECRET = 'offline-test';

  const register = mock(
    async (input: { convexUrlId: string; longUrl: string; monitoringVersion?: number }) => ({
      id: `link-${input.convexUrlId}`,
      monitoringVersion: input.monitoringVersion ?? 0,
      isDeleted: false,
    })
  );
  const unregister = mock(async (_convexUrlId: string, _env: 'dev' | 'prod', version = 0) => ({
    id: 'link-deleted',
    monitoringVersion: version,
    isDeleted: true,
  }));
  const checkDependencies = mock(async () => {});
  const errorLog = mock(() => {});
  const captureException = mock(() => {});
  let now = 1_000_000;

  const lookup = spyOn(dns, 'lookup');

  afterEach(() => {
    register.mockClear();
    unregister.mockClear();
    checkDependencies.mockClear();
    errorLog.mockClear();
    captureException.mockClear();
    lookup.mockClear();
    process.env.MONITORING_API_SECRET = 'offline-test';
    Object.assign(serviceState, savedServiceState);
  });

  afterAll(() => {
    lookup.mockRestore();
    if (savedSecret === undefined) delete process.env.MONITORING_API_SECRET;
    else process.env.MONITORING_API_SECRET = savedSecret;
    Object.assign(serviceState, savedServiceState);
  });

  const makeApp = () =>
    createApp(false, false, {
      registerMonitor: register as never,
      unregisterMonitor: unregister as never,
      checkDependencies,
      logger: { error: errorLog } as never,
      captureException,
      now: () => now,
    });

  const app = makeApp();
  const request = (path: string, body: unknown, target = app) =>
    target.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer offline-test',
        },
        body: JSON.stringify(body),
      })
    );
  const send = (path: string, init: RequestInit, target = app) =>
    target.handle(new Request(`http://localhost${path}`, init));

  const link = {
    convexUrlId: 'url-1',
    convexUserId: 'user-1',
    shortUrl: 'short',
    monitoringVersion: 3,
  };
  const rejectedUrls = [
    'not a url',
    'ftp://example.com/file',
    'https://user:secret@example.com/',
    'http://localhost:3000/',
    'http://api.localhost/',
    'http://redis/',
    'http://postgres:8080/',
    'http://10.0.0.5/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://[::127.0.0.1]/',
    'http://[::ffff:0:127.0.0.1]/',
    'http://[fd00::1]/',
    'http://[::ffff:127.0.0.1]/',
    'https://example.com:8000/',
    'http://example.com:5432/',
  ];

  test('public and unresolvable hostnames register without a DNS lookup', async () => {
    for (const longUrl of [
      'https://Example.com/landing',
      'https://expired-domain.invalid/offer',
    ]) {
      const response = await request('/monitors/register', { ...link, longUrl });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        success: true,
        linkId: 'link-url-1',
        monitoringVersion: 3,
        isDeleted: false,
      });
    }
    expect(register.mock.calls.map(([input]) => (input as { longUrl: string }).longUrl)).toEqual([
      'https://example.com/landing',
      'https://expired-domain.invalid/offer',
    ]);
    expect(lookup).not.toHaveBeenCalled();
  });

  test('a URL that can never be monitored is a 400 invalid_url and is not saved', async () => {
    for (const longUrl of rejectedUrls) {
      const response = await request('/monitors/register', { ...link, longUrl });
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toEqual({
        success: false,
        code: 'invalid_url',
        error: expect.any(String),
      });
      // Short fixed messages: no addresses or credentials are echoed back.
      expect(body.error).not.toMatch(/\d+\.\d+\.\d+\.\d+|::|secret/);
    }
    expect(register).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  test('unregister requires a non-empty convexUrlId and returns the saved receipt', async () => {
    const empty = await request('/monitors/unregister', { convexUrlId: '' });
    expect(empty.status).toBe(422);
    expect(unregister).not.toHaveBeenCalled();

    const ok = await request('/monitors/unregister', {
      convexUrlId: 'url-1',
      environment: 'prod',
      monitoringVersion: 4,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      success: true,
      disabledCount: 1,
      monitoringVersion: 4,
      isDeleted: true,
    });
  });

  test('removed zero-caller /monitors/* endpoints are no longer exposed', async () => {
    const authHeaders = {
      'content-type': 'application/json',
      authorization: 'Bearer offline-test',
    };
    const id = '11111111-1111-4111-8111-111111111111';
    for (const [path, method] of [
      ['/monitors/batch', 'POST'],
      [`/monitors/${id}/force-check`, 'POST'],
      [`/monitors/${id}`, 'GET'],
      [`/monitors/${id}`, 'DELETE'],
    ] as const) {
      const response = await send(path, {
        method,
        headers: authHeaders,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(response.status).toBe(404);
    }
  });

  test('requests without the secret get 401 before the body or parameters are parsed or validated', async () => {
    const unauthenticated: Array<[string, RequestInit]> = [
      ['/monitors/register', { method: 'POST', body: '{}' }],
      ['/monitors/register', { method: 'POST', body: '{"longUrl": 42' }],
      [
        '/monitors/register',
        {
          method: 'POST',
          body: JSON.stringify({ ...link, longUrl: 'https://example.com/' }),
        },
      ],
      ['/monitors/unregister', { method: 'POST', body: '[]' }],
    ];
    for (const authorization of [
      undefined,
      '',
      'Bearer wrong',
      'Bearer offline-tes',
      'Bearer offline-test-extra',
      'offline-test',
      'bearer offline-test',
      'Basic b2ZmbGluZS10ZXN0',
    ]) {
      for (const [path, init] of unauthenticated) {
        const response = await send(path, {
          ...init,
          headers: {
            'content-type': 'application/json',
            ...(authorization === undefined ? {} : { authorization }),
          },
        });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'Access denied' });
      }
    }
    expect(register).not.toHaveBeenCalled();
    expect((await send('/health', { method: 'GET' })).status).toBe(200);
  });

  test('authenticated requests are still validated', async () => {
    const response = await request('/monitors/register', {
      longUrl: 'https://example.com/',
    });
    expect(response.status).toBe(422);
    expect(register).not.toHaveBeenCalled();
  });

  test('the bearer secret is compared in constant time', async () => {
    const compare = spyOn(crypto, 'timingSafeEqual');
    try {
      expect(hasValidBearerToken('Bearer offline-test', 'offline-test')).toBe(
        true
      );
      for (const header of [
        null,
        '',
        'Bearer x',
        'Bearer offline-tesT',
        `Bearer ${'offline-test'.repeat(50)}`,
      ]) {
        expect(hasValidBearerToken(header, 'offline-test')).toBe(false);
      }
      expect(compare).toHaveBeenCalledTimes(6);
      // Both sides are SHA-256 digests, so their length never depends on the input.
      for (const [actual, expected] of compare.mock.calls) {
        expect(actual.byteLength).toBe(32);
        expect(expected.byteLength).toBe(32);
      }
      compare.mockClear();
      expect(
        (
          await send('/monitors/unregister', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer short',
            },
            body: '{}',
          })
        ).status
      ).toBe(401);
      expect(compare).toHaveBeenCalled();
    } finally {
      compare.mockRestore();
    }
  });

  test('routes are unavailable when the API secret is not configured', async () => {
    delete process.env.MONITORING_API_SECRET;
    const response = await request('/monitors/register', {});
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'Service is not configured' });
  });

  test('unexpected storage failures return generic 500 without leaking internals and log/report to Sentry', async () => {
    const dbError = new Error(
      'DrizzleError: relation "monitored_links" failed on postgres://secret@db:5432/prod'
    );
    register.mockImplementationOnce(async () => {
      throw dbError;
    });
    const response = await request('/monitors/register', {
      ...link,
      longUrl: 'https://example.com/',
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(dbError);
  });

  test('GET /ready coalesces concurrent checks and caches dependency readiness for 2s', async () => {
    const readyApp = makeApp();
    serviceState.started = false;
    serviceState.stopping = false;
    expect((await send('/ready', { method: 'GET' }, readyApp)).status).toBe(
      503
    );
    expect(checkDependencies).not.toHaveBeenCalled();

    serviceState.started = true;
    let release!: () => void;
    checkDependencies.mockImplementationOnce(
      () =>
        new Promise<void>(resolve => {
          release = resolve;
        })
    );

    const concurrent = Promise.all([
      send('/ready', { method: 'GET' }, readyApp),
      send('/ready', { method: 'GET' }, readyApp),
      send('/ready', { method: 'GET' }, readyApp),
    ]);
    await Bun.sleep(10);
    expect(checkDependencies).toHaveBeenCalledTimes(1);
    release();
    const responses = await concurrent;
    expect(responses.map(r => r.status)).toEqual([200, 200, 200]);

    // Within 2s TTL: served from cache without calling dependencies again.
    now += 1_500;
    expect((await send('/ready', { method: 'GET' }, readyApp)).status).toBe(
      200
    );
    expect(checkDependencies).toHaveBeenCalledTimes(1);

    // After 2s TTL expires: re-checks dependencies and reflects failure.
    now += 600;
    checkDependencies.mockImplementationOnce(async () => {
      throw new Error('Redis PING failed');
    });
    expect((await send('/ready', { method: 'GET' }, readyApp)).status).toBe(
      503
    );
    expect(checkDependencies).toHaveBeenCalledTimes(2);
  });
});
