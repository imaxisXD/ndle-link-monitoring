import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

const address = process.env.MONITOR_TEST_DATABASE_URL;
const redisAddress = process.env.MONITOR_TEST_REDIS_URL;
if (address || redisAddress) {
  const database = new URL(address ?? '');
  const redis = new URL(redisAddress ?? '');
  if (!['127.0.0.1', 'localhost'].includes(database.hostname) || database.pathname !== '/monitoring_test' ||
      !['127.0.0.1', 'localhost'].includes(redis.hostname) || redis.pathname !== '/15') {
    throw new Error('Integration tests require the isolated local monitoring_test database and Redis database 15');
  }
  process.env.DATABASE_URL = address;
  process.env.REDIS_URL = redisAddress;
  process.env.MONITORING_SHARED_SECRET = 'test-only';
  process.env.NODE_ENV = 'production';
}

if (address && redisAddress) {
let measurements = 0;
let deliveries: unknown[] = [];
let rejectDelivery = false;
const result = { statusCode: 200, latencyMs: 10, isHealthy: true, healthStatus: 'up' as const };
mock.module('./lib/checker', () => ({ checkUrl: async () => { measurements++; return result; } }));
mock.module('./lib/convex', () => ({ getConvexClient: () => ({ mutation: async (_reference: unknown, value: unknown) => { deliveries.push(value); if (rejectDelivery) throw new Error('Simulated delivery outage'); return { success: true }; } }) }));

describe('durable monitoring with isolated PostgreSQL and Redis', async () => {
  const { db } = await import('./db');
  const { monitoredLinks, monitorChecks } = await import('./db/schema');
  const { eq } = await import('drizzle-orm');
  const { registerMonitor, unregisterMonitor } = await import('./lib/monitor-store');
  const { claimDueChecks, dispatchChecks } = await import('./scheduler');
  const { processJob } = await import('./worker');
  const { getQueue, closeAllConnections } = await import('./queue/factory');
  const input = { convexUrlId: 'url-test', convexUserId: 'user-test', longUrl: 'https://example.test', shortUrl: 'short', environment: 'prod' as const, monitoringVersion: 1 };

  beforeEach(async () => {
    process.env.MONITORING_ENVIRONMENTS = "prod";
    await getQueue().obliterate({ force: true });
    await db.delete(monitorChecks); await db.delete(monitoredLinks);
    measurements = 0; deliveries = []; rejectDelivery = false;
  });
  afterAll(closeAllConnections);

  test('deletion wins equal versions, even when it arrives before registration', async () => {
    await unregisterMonitor(input.convexUrlId, 'prod', 2);
    await registerMonitor(input);
    await registerMonitor({ ...input, monitoringVersion: 2 });
    const deleted = await db.query.monitoredLinks.findFirst();
    expect(deleted?.isDeleted).toBe(true);
    await registerMonitor({ ...input, monitoringVersion: 3 });
    expect((await db.query.monitoredLinks.findFirst())?.isDeleted).toBe(false);
  });

  test('repeated registration does not reset a future schedule', async () => {
    await registerMonitor(input);
    await claimDueChecks();
    const before = await db.query.monitoredLinks.findFirst();
    await registerMonitor(input);
    expect((await db.query.monitoredLinks.findFirst())?.nextCheckAt).toEqual(before?.nextCheckAt);
  });

  test('concurrent schedulers claim one occurrence and redis redispatch keeps its ID', async () => {
    await registerMonitor(input);
    await Promise.all([claimDueChecks(), claimDueChecks()]);
    const checks = await db.select().from(monitorChecks);
    expect(checks).toHaveLength(1);
    await dispatchChecks();
    await db.update(monitorChecks).set({ queueLeaseUntil: null });
    await dispatchChecks();
    expect(await getQueue().getJobCounts('waiting', 'prioritized')).toMatchObject({ waiting: 1, prioritized: 0 });
    expect((await getQueue().getJob(checks[0].id))?.data.checkId).toBe(checks[0].id);
  });

  test('delivery failure retains measurement and retry sends the same result', async () => {
    const link = await registerMonitor(input);
    await claimDueChecks();
    const check = (await db.select().from(monitorChecks))[0];
    const job = { id: check.id, data: { ...input, linkId: link!.id, checkId: check.id } };
    rejectDelivery = true;
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect((await db.query.monitorChecks.findFirst())?.result).toEqual(result);
    rejectDelivery = false;
    await processJob(job);
    await processJob(job);
    expect(measurements).toBe(1);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toEqual(deliveries[1]);
    expect((await db.query.monitorChecks.findFirst())?.finishedAt).not.toBeNull();
  });

  test('a development-only scheduler leaves production links due', async () => {
    await registerMonitor(input);
    process.env.MONITORING_ENVIRONMENTS = 'dev';
    expect(await claimDueChecks()).toBe(0);
    expect(await db.select().from(monitorChecks)).toHaveLength(0);
  });

  test('unregister acknowledgement reports the newer stored version for a stale deletion', async () => {
    await registerMonitor({ ...input, monitoringVersion: 5 });
    const receipt = await unregisterMonitor(input.convexUrlId, 'prod', 4);
    expect(receipt?.monitoringVersion).toBe(5);
    expect(receipt?.isDeleted).toBe(false);
  });

  test('HTTP registration and deletion acknowledge saved state and require authentication', async () => {
    process.env.MONITORING_API_SECRET = 'local-api-test';
    const { createApp } = await import('./app');
    const app = createApp(false, false);
    const request = (path: string, body: unknown, authenticated = true) => app.handle(new Request(`http://localhost${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer local-api-test' } : {}) }, body: JSON.stringify(body),
    }));
    const registration = { ...input, longUrl: 'https://8.8.8.8' };
    expect((await request('/monitors/register', registration, false)).status).toBe(401);
    const registered = await request('/monitors/register', registration);
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ success: true, monitoringVersion: 1, isDeleted: false });
    const deleted = await request('/monitors/unregister', { convexUrlId: input.convexUrlId, environment: 'prod', monitoringVersion: 2 });
    expect(await deleted.json()).toMatchObject({ success: true, monitoringVersion: 2, isDeleted: true });
  });

  test('queued checks for removed or changed monitors make no destination request', async () => {
    const link = await registerMonitor(input);
    await claimDueChecks();
    const check = (await db.select().from(monitorChecks))[0];
    await unregisterMonitor(input.convexUrlId, 'prod', 2);
    await processJob({ id: check.id, data: { ...input, linkId: link!.id, checkId: check.id } });
    expect(measurements).toBe(0); expect(deliveries).toHaveLength(0);
    expect((await db.query.monitorChecks.findFirst({ where: eq(monitorChecks.id, check.id) }))?.finishedAt).not.toBeNull();
  });
});

} else { test.skip("monitor integration tests need isolated local test services", () => {}); }
