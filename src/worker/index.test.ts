import { afterAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { MAX_DELIVERY_ATTEMPTS } from '../lib/monitor-policy';

// The integration suite replaces these modules and uses real services, so this suite stays out of its way.
if (!process.env.MONITOR_TEST_DATABASE_URL && !process.env.MONITOR_TEST_REDIS_URL) {
const saved = {
  DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL,
  MONITORING_SHARED_SECRET: process.env.MONITORING_SHARED_SECRET, MONITORING_ENVIRONMENTS: process.env.MONITORING_ENVIRONMENTS,
};
// Closed local ports: nothing in this suite can reach a real database or Redis.
Object.assign(process.env, { DATABASE_URL: 'postgres://127.0.0.1:1/offline_test', REDIS_URL: 'redis://127.0.0.1:1/15', MONITORING_SHARED_SECRET: 'offline-test' });
delete process.env.MONITORING_ENVIRONMENTS;

describe('result delivery retries without PostgreSQL', async () => {
  const { db } = await import('../db');
  const convex = await import('../lib/convex');
  const loggers = await import('../lib/logger');
  const { processJob } = await import('./index');

  const now = Date.now();
  const link = {
    id: 'link-1', convexUrlId: 'url-1', convexUserId: 'user-1', monitoringVersion: 2, isDeleted: false, environment: 'prod',
    longUrl: 'https://example.com/', shortUrl: 'short', isActive: true,
  };
  const result = { statusCode: 200, latencyMs: 12, isHealthy: true, healthStatus: 'up' };
  let check: Record<string, unknown>;
  let newerDelivered: Array<{ id: string }>;
  let updates: Array<Record<string, unknown>>;
  let mutationOptions: unknown[];
  let logged: { warn: unknown[][]; error: unknown[][] };

  const spies = [
    spyOn(db.query.monitorChecks, 'findFirst').mockImplementation((async () => check) as never),
    spyOn(db.query.monitoredLinks, 'findFirst').mockImplementation((async () => link) as never),
    spyOn(db, 'select').mockImplementation((() => ({ from: () => ({ where: () => ({ limit: async () => newerDelivered }) }) })) as never),
    spyOn(db, 'update').mockImplementation((() => ({
      set: (values: Record<string, unknown>) => ({ where: async () => { updates.push(values); return []; } }),
    })) as never),
    spyOn(convex, 'getConvexClient').mockImplementation((() => ({
      mutation: async (_reference: unknown, _args: unknown, options: unknown) => {
        mutationOptions.push(options);
        throw new Error('Simulated delivery outage');
      },
    })) as never),
    spyOn(loggers, 'createWorkerLogger').mockImplementation((() => ({
      warn: (...args: unknown[]) => logged.warn.push(args), error: (...args: unknown[]) => logged.error.push(args),
      info: () => {}, debug: () => {},
    })) as never),
  ];
  afterAll(() => {
    for (const spy of spies) spy.mockRestore();
    for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  });

  beforeEach(() => {
    newerDelivered = []; updates = []; mutationOptions = []; logged = { warn: [], error: [] };
    check = {
      id: 'check-1', linkId: link.id, monitoringVersion: 2, source: 'scheduled', result,
      scheduledAt: new Date(now - 120_000), measuredAt: new Date(now - 60_000),
      deliveryAttempts: 0, finishedAt: null, failedAt: null, lastError: null,
    };
  });
  const job = { id: 'check-1', data: { checkId: 'check-1', linkId: link.id, convexUrlId: link.convexUrlId, longUrl: link.longUrl, shortUrl: link.shortUrl, environment: 'prod' as const } };

  test('a failed delivery is retried later while under the limits, without the shared mutation queue', async () => {
    check.deliveryAttempts = 4;
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect(mutationOptions).toEqual([{ skipQueue: true }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ lastError: 'Simulated delivery outage', queueLeaseUntil: null });
    expect((updates[0].nextAttemptAt as Date).getTime()).toBeGreaterThan(now);
    expect(updates[0]).not.toHaveProperty('finishedAt');
    expect(updates[0]).not.toHaveProperty('failedAt');
    expect(logged.error).toHaveLength(0);
  });

  test('the last allowed failed attempt marks the result permanently failed and logs the error', async () => {
    check.deliveryAttempts = MAX_DELIVERY_ATTEMPTS - 1;
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect(updates[0].finishedAt).toBeInstanceOf(Date);
    expect(updates[0].failedAt).toEqual(updates[0].finishedAt);
    expect(logged.error).toHaveLength(1);
    const [fields, message] = logged.error[0] as [Record<string, unknown>, string];
    expect(fields).toMatchObject({ attempts: MAX_DELIVERY_ATTEMPTS, reason: 'attempt_limit' });
    expect(fields.err).toBeInstanceOf(Error);
    expect(message).toContain('permanently');
  });

  test('a result stored more than 24 hours ago stops retrying after its next failure', async () => {
    Object.assign(check, { deliveryAttempts: 2, measuredAt: new Date(now - 24 * 60 * 60 * 1000 - 1000) });
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect(updates[0].failedAt).toBeInstanceOf(Date);
    expect(logged.error[0][0]).toMatchObject({ reason: 'age_limit' });
  });

  test('a result superseded by a newer delivered check stops retrying at once', async () => {
    newerDelivered = [{ id: 'check-2' }];
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect(updates[0].failedAt).toBeInstanceOf(Date);
    expect(updates[0].finishedAt).toBeInstanceOf(Date);
    expect(logged.error).toHaveLength(0);
    expect(logged.warn).toHaveLength(1);
    expect((logged.warn[0][0] as Record<string, unknown>).err).toBeInstanceOf(Error);
  });
});
} else { test.skip('offline worker retry tests run only in the offline suite', () => {}); }
