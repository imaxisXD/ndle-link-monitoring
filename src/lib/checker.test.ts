import { afterEach, describe, expect, test } from 'bun:test';
import pino from 'pino';
import { checkUrl, classifyResponse, withHostSlot } from './checker';
import { DEGRADED_THRESHOLD_MS } from './constants';
import {
  setServerAddresses,
  type ResolveHost,
  type SendRequest,
} from './url-safety';

const silent = pino({ level: 'silent' });
const publicAddress: ResolveHost = async () => [
  { address: '93.184.215.14', family: 4 },
];
const reply = (status: number, headers?: Record<string, string>) =>
  new Response(null, { status, headers });

function recordingSend(
  answer: (
    url: URL,
    method: string,
    headers: Record<string, string>
  ) => Response | Promise<Response>
) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Record<string, string>;
  }> = [];
  const send: SendRequest = async (url, request) => {
    calls.push({
      url: url.toString(),
      method: request.method,
      headers: request.headers,
    });
    return answer(url, request.method, request.headers);
  };
  return { send, calls };
}

describe('destination checks without network access', () => {
  afterEach(() => setServerAddresses([]));

  test('a domain that does not resolve is recorded as down', async () => {
    for (const code of ['ENOTFOUND', 'EAI_NONAME']) {
      const unresolved: ResolveHost = async hostname => {
        throw Object.assign(new Error(`getaddrinfo ${code} ${hostname}`), {
          code,
        });
      };
      expect(
        await checkUrl('https://expired-domain.invalid/offer', silent, {
          resolveHost: unresolved,
        })
      ).toMatchObject({
        statusCode: 0,
        isHealthy: false,
        healthStatus: 'down',
        errorMessage: 'Domain does not resolve',
      });
    }
  });

  test('a destination that resolves to a private address is recorded without the address', async () => {
    for (const record of [
      { address: '10.20.30.40', family: 4 },
      { address: '::ffff:a14:1e28', family: 6 },
    ]) {
      const result = await checkUrl('https://internal.example/', silent, {
        resolveHost: async () => [record],
      });
      expect(result).toMatchObject({
        statusCode: 0,
        isHealthy: false,
        healthStatus: 'down',
      });
      expect(result.errorMessage).toBe('Destination is not allowed');
      expect(result.errorMessage).not.toContain(record.address);
    }
  });

  test('a destination on this server or on a blocked port is not requested and not reported as down', async () => {
    setServerAddresses(['45.33.32.156']);
    const { send, calls } = recordingSend(() => reply(200));
    for (const [longUrl, resolveHost] of [
      [
        'https://monitor.ndle.example/',
        async () => [{ address: '45.33.32.156', family: 4 }],
      ],
      ['http://example.com:8000/', publicAddress],
    ] as const) {
      expect(await checkUrl(longUrl, silent, { resolveHost, send })).toEqual({
        statusCode: 0,
        latencyMs: expect.any(Number),
        isHealthy: false,
        healthStatus: 'unknown',
        errorMessage: 'Destination is not allowed',
      });
    }
    expect(calls).toHaveLength(0);
  });

  test('final responses are classified by status code', () => {
    for (const status of [200, 204, 301, 302, 304, 399]) {
      expect(classifyResponse(status, 10)).toEqual({
        isHealthy: true,
        healthStatus: 'up',
      });
    }
    for (const status of [404, 410, 500, 501, 502, 504, 400]) {
      expect(classifyResponse(status, 10)).toEqual({
        isHealthy: false,
        healthStatus: 'down',
      });
    }
    for (const status of [401, 403, 405, 406, 429, 503]) {
      expect(classifyResponse(status, 10)).toEqual({
        isHealthy: false,
        healthStatus: 'unknown',
      });
    }
    expect(classifyResponse(200, DEGRADED_THRESHOLD_MS)).toEqual({
      isHealthy: true,
      healthStatus: 'up',
    });
    expect(classifyResponse(200, DEGRADED_THRESHOLD_MS + 1)).toEqual({
      isHealthy: true,
      healthStatus: 'degraded',
    });
    expect(classifyResponse(429, DEGRADED_THRESHOLD_MS + 1).healthStatus).toBe(
      'unknown'
    );
  });

  test('bot protection, authentication and rate limiting are unknown; missing pages and server errors are down', async () => {
    const expected: Record<number, string> = {
      200: 'up',
      404: 'down',
      410: 'down',
      500: 'down',
      502: 'down',
      504: 'down',
      401: 'unknown',
      403: 'unknown',
      405: 'unknown',
      406: 'unknown',
      429: 'unknown',
      503: 'unknown',
    };
    await Promise.all(
      Object.entries(expected).map(async ([status, healthStatus]) => {
        const { send } = recordingSend(() => reply(Number(status)));
        const result = await checkUrl(
          `https://status-${status}.example/`,
          silent,
          { resolveHost: publicAddress, send, fallbackDelayMs: 0 }
        );
        expect(result).toEqual({
          statusCode: Number(status),
          latencyMs: expect.any(Number),
          isHealthy: status === '200',
          healthStatus: healthStatus as never,
        });
      })
    );
  });

  test('HEAD answers of 400, 403, 404, 405, 406 and 501 are retried once with GET reusing the same User-Agent', async () => {
    await Promise.all(
      [400, 403, 404, 405, 406, 501].map(async status => {
        const { send, calls } = recordingSend((_url, method) =>
          reply(method === 'HEAD' ? status : 200)
        );
        expect(
          await checkUrl(`https://head-${status}.example/`, silent, {
            resolveHost: publicAddress,
            send,
            fallbackDelayMs: 0,
          })
        ).toMatchObject({
          statusCode: 200,
          isHealthy: true,
          healthStatus: 'up',
        });
        expect(calls.map(call => call.method)).toEqual(['HEAD', 'GET']);
        expect(calls[0].headers['user-agent']).toBe(
          calls[1].headers['user-agent']
        );
      })
    );
    const confirmed = recordingSend(() => reply(404));
    expect(
      await checkUrl('https://missing.example/', silent, {
        resolveHost: publicAddress,
        send: confirmed.send,
        fallbackDelayMs: 0,
      })
    ).toMatchObject({ statusCode: 404, healthStatus: 'down' });
    expect(confirmed.calls.map(call => call.method)).toEqual(['HEAD', 'GET']);
  });

  test('HEAD -> GET fallback resets latency timer before GET and aborts fallback sleep on timeout', async () => {
    const { send } = recordingSend(async (_url, method) => {
      if (method === 'HEAD') {
        await Bun.sleep(60);
        return reply(405);
      }
      return reply(200);
    });
    const result = await checkUrl('https://reset-timer.example/', silent, {
      resolveHost: publicAddress,
      send,
      fallbackDelayMs: 60,
    });
    expect(result.statusCode).toBe(200);
    // Latency should reflect only the fast GET, not the 60ms HEAD + 60ms sleep.
    expect(result.latencyMs).toBeLessThan(50);

    // Timeout during fallback sleep aborts immediately without issuing GET.
    const slowSleep = recordingSend(() => reply(405));
    const started = Date.now();
    const timedOut = await checkUrl('https://abort-sleep.example/', silent, {
      resolveHost: publicAddress,
      send: slowSleep.send,
      timeoutMs: 30,
      fallbackDelayMs: 5_000,
    });
    expect(Date.now() - started).toBeLessThan(500);
    expect(timedOut).toMatchObject({
      statusCode: 408,
      isHealthy: false,
      healthStatus: 'down',
      errorMessage: 'Connection timed out',
    });
    expect(slowSleep.calls.map(c => c.method)).toEqual(['HEAD']);
  });

  test('other HEAD answers are classified without a GET', async () => {
    await Promise.all(
      [200, 302, 410, 429, 500, 503].map(async status => {
        const { send, calls } = recordingSend(() => reply(status));
        await checkUrl(`https://head-only-${status}.example/`, silent, {
          resolveHost: publicAddress,
          send,
        });
        expect(calls.map(call => call.method)).toEqual(['HEAD']);
      })
    );
  });

  test('up to 10 redirects are followed and every hop is resolved and validated', async () => {
    const chain = (length: number) => {
      const resolved: string[] = [];
      const resolveHost: ResolveHost = async hostname => {
        resolved.push(hostname);
        return publicAddress(hostname);
      };
      const { send, calls } = recordingSend(url => {
        const hop = Number(url.searchParams.get('hop'));
        return hop < length
          ? reply(302, {
              location: `https://hop-${hop + 1}.example/?hop=${hop + 1}`,
            })
          : reply(200);
      });
      return { resolveHost, send, calls, resolved };
    };
    const ten = chain(10);
    expect(
      await checkUrl('https://start.example/?hop=0', silent, ten)
    ).toMatchObject({ statusCode: 200, isHealthy: true, healthStatus: 'up' });
    expect(ten.calls).toHaveLength(11);
    expect(ten.resolved).toEqual([
      'start.example',
      ...Array.from({ length: 10 }, (_, hop) => `hop-${hop + 1}.example`),
    ]);

    const eleven = chain(11);
    expect(
      await checkUrl('https://start.example/?hop=0', silent, eleven)
    ).toEqual({
      statusCode: 0,
      latencyMs: expect.any(Number),
      isHealthy: false,
      healthStatus: 'down',
      errorMessage: 'Too many redirects',
    });
    expect(eleven.calls).toHaveLength(11);
  });

  test('an aborted request is a timeout even when it rejects with ECONNREFUSED', async () => {
    const send: SendRequest = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(
            Object.assign(new Error('connect ECONNREFUSED 93.184.215.14:443'), {
              code: 'ECONNREFUSED',
            })
          )
        );
      });
    expect(
      await checkUrl('https://slow.example/', silent, {
        resolveHost: publicAddress,
        send,
        timeoutMs: 30,
      })
    ).toEqual({
      statusCode: 408,
      latencyMs: expect.any(Number),
      isHealthy: false,
      healthStatus: 'down',
      errorMessage: 'Connection timed out',
    });
  });

  test('connection failures are recorded with fixed messages, never the raw error', async () => {
    const cases: Array<[Error, string]> = [
      [
        Object.assign(new Error('connect ECONNREFUSED 93.184.215.14:443'), {
          code: 'ECONNREFUSED',
        }),
        'Connection refused',
      ],
      [
        Object.assign(
          new Error(
            "Hostname/IP does not match certificate's altnames: Host: tls.example"
          ),
          { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
        ),
        'Secure connection failed',
      ],
      [
        Object.assign(new Error('certificate has expired'), {
          code: 'CERT_HAS_EXPIRED',
        }),
        'Secure connection failed',
      ],
      [
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        'Connection failed',
      ],
      [
        new Error('Parse Error: https://example.com/?token=secret'),
        'Unexpected error',
      ],
    ];
    for (const [error, errorMessage] of cases) {
      const send: SendRequest = async () => {
        throw error;
      };
      const result = await checkUrl('https://failing.example/', silent, {
        resolveHost: publicAddress,
        send,
      });
      expect(result).toEqual({
        statusCode: 0,
        latencyMs: expect.any(Number),
        isHealthy: false,
        healthStatus: 'down',
        errorMessage,
      });
    }
  });

  test('at most two checks are in flight per hostname, and other hostnames are not held back', async () => {
    const active = new Map<string, number>();
    let peak = 0;
    const pending: Array<() => void> = [];
    const send: SendRequest = async url => {
      const host = url.hostname.replace(/\.$/, '');
      const count = (active.get(host) ?? 0) + 1;
      active.set(host, count);
      if (host === 'popular.example') peak = Math.max(peak, count);
      await new Promise<void>(resolve => pending.push(resolve));
      active.set(host, (active.get(host) ?? 1) - 1);
      return reply(200);
    };
    let finished = false;
    const checks = Promise.all([
      ...Array.from({ length: 5 }, () =>
        checkUrl('https://popular.example/', silent, {
          resolveHost: publicAddress,
          send,
        })
      ),
      checkUrl('https://Popular.Example./page', silent, {
        resolveHost: publicAddress,
        send,
      }),
      checkUrl('https://other.example/', silent, {
        resolveHost: publicAddress,
        send,
      }),
    ]).finally(() => {
      finished = true;
    });
    await Bun.sleep(20);
    expect(active.get('popular.example')).toBe(2);
    expect(active.get('other.example')).toBe(1);
    while (!finished) {
      pending.splice(0).forEach(release => release());
      await Bun.sleep(5);
    }
    const results = await checks;
    expect(results.map(result => result.healthStatus)).toEqual(
      Array(7).fill('up')
    );
    expect(peak).toBe(2);

    // Failed checks release their slot too.
    const failing: SendRequest = async () => {
      throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    };
    const failed = await Promise.all(
      Array.from({ length: 5 }, () =>
        checkUrl('https://popular.example/', silent, {
          resolveHost: publicAddress,
          send: failing,
        })
      )
    );
    expect(failed.map(result => result.errorMessage)).toEqual(
      Array(5).fill('Connection refused')
    );
  });

  test('withHostSlot aborts waiting checks without leaking slots and caps wait to check timeout', async () => {
    const releases: Array<() => void> = [];
    const blocker: SendRequest = () =>
      new Promise<Response>(resolve => {
        releases.push(() => resolve(reply(200)));
      });

    // Occupy both slots on hol.example.
    const first = checkUrl('https://hol.example/1', silent, {
      resolveHost: publicAddress,
      send: blocker,
      timeoutMs: 5_000,
    });
    const second = checkUrl('https://hol.example/2', silent, {
      resolveHost: publicAddress,
      send: blocker,
      timeoutMs: 5_000,
    });
    await Bun.sleep(15);
    expect(releases).toHaveLength(2);

    // A 3rd check with a 30ms timeout aborts while waiting for a slot instead of blocking indefinitely.
    let ranThird = false;
    const thirdStarted = Date.now();
    const third = await checkUrl('https://hol.example/3', silent, {
      resolveHost: publicAddress,
      send: async () => {
        ranThird = true;
        return reply(200);
      },
      timeoutMs: 30,
    });
    expect(Date.now() - thirdStarted).toBeLessThan(500);
    expect(ranThird).toBe(false);
    expect(third).toMatchObject({
      statusCode: 408,
      isHealthy: false,
      healthStatus: 'down',
      errorMessage: 'Connection timed out',
    });

    // Directly testing withHostSlot with an already-aborted signal rejects immediately without running.
    const preAborted = new AbortController();
    preAborted.abort(new DOMException('Aborted', 'AbortError'));
    let preRan = false;
    await expect(
      withHostSlot(
        'https://hol.example/pre',
        async () => {
          preRan = true;
        },
        preAborted.signal
      )
    ).rejects.toThrow();
    expect(preRan).toBe(false);

    // Release the 2 occupied slots and confirm subsequent checks work cleanly (no leaked waiter or count).
    releases.splice(0).forEach(release => release());
    await Promise.all([first, second]);

    const after = await checkUrl('https://hol.example/4', silent, {
      resolveHost: publicAddress,
      send: async () => reply(200),
    });
    expect(after).toMatchObject({ statusCode: 200, healthStatus: 'up' });
  });
});
