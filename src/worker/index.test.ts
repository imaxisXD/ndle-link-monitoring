import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  computeDeliveryRetryDelayMs,
  MAX_DELIVERY_ATTEMPTS,
} from '../lib/monitor-policy';
import { serviceState } from '../lib/service-state';
import {
  attachWorkerReadiness,
  createJobProcessor,
  type BlockingClientLike,
  type WorkerLike,
} from './index';

describe('worker job processing and retries', () => {
  const now = Date.now();
  const baseLink = {
    id: 'link-1',
    convexUrlId: 'url-1',
    convexUserId: 'user-1',
    monitoringVersion: 2,
    isDeleted: false,
    environment: 'prod' as const,
    longUrl: 'https://example.com/',
    shortUrl: 'short',
    isActive: true,
  };
  const sampleResult = {
    statusCode: 200,
    latencyMs: 12,
    isHealthy: true,
    healthStatus: 'up' as const,
  };

  let check: Record<string, unknown>;
  let link: typeof baseLink;
  let newerDelivered: Array<{ id: string }>;
  let claimLeaseResult: unknown[];
  let updates: Array<Record<string, unknown>>;
  let transactionCalls: number;
  let mutationOptions: unknown[];
  let convexResponse: unknown;
  let convexShouldThrow: boolean;
  let logged: { warn: unknown[][]; error: unknown[][]; debug: unknown[][] };
  let checkUrlMock: ReturnType<typeof mock>;
  let randomValue: number;

  function createFakeDb() {
    let selectCall = 0;
    const makeTx = () => ({
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            updates.push(values);
            const updatedRow = { ...check, ...values };
            return Object.assign(Promise.resolve([updatedRow]), {
              returning: async () => [updatedRow],
            });
          },
        }),
      }),
    });

    return {
      select: (selection?: Record<string, unknown>) => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => [{ check, link }],
            }),
          }),
          where: () => ({
            limit: async () => {
              selectCall++;
              if (selection && 'isDeleted' in selection) {
                return [
                  {
                    isDeleted: link.isDeleted,
                    monitoringVersion: link.monitoringVersion,
                  },
                ];
              }
              return newerDelivered;
            },
          }),
        }),
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: () => {
            const isLeaseClaim = 'measurementLeaseUntil' in values;
            if (!isLeaseClaim) updates.push(values);
            return Object.assign(Promise.resolve([]), {
              returning: async () => (isLeaseClaim ? claimLeaseResult : []),
            });
          },
        }),
      }),
      transaction: async <T>(
        fn: (tx: ReturnType<typeof makeTx>) => Promise<T>
      ) => {
        transactionCalls++;
        return fn(makeTx());
      },
      getSelectCalls: () => selectCall,
    };
  }

  let fakeDb: ReturnType<typeof createFakeDb>;
  let processJob: ReturnType<typeof createJobProcessor>;

  beforeEach(() => {
    newerDelivered = [];
    claimLeaseResult = [{ id: 'check-1' }];
    updates = [];
    transactionCalls = 0;
    mutationOptions = [];
    convexResponse = { success: true };
    convexShouldThrow = true;
    randomValue = 0.5;
    logged = { warn: [], error: [], debug: [] };
    link = { ...baseLink };
    check = {
      id: 'check-1',
      linkId: link.id,
      monitoringVersion: 2,
      source: 'scheduled',
      result: sampleResult,
      scheduledAt: new Date(now - 120_000),
      measuredAt: new Date(now - 60_000),
      deliveryAttempts: 0,
      finishedAt: null,
      failedAt: null,
      lastError: null,
    };
    checkUrlMock = mock(async () => sampleResult);
    fakeDb = createFakeDb();
    processJob = createJobProcessor({
      db: fakeDb as never,
      checkUrl: checkUrlMock as never,
      enabledEnvironments: () => ['prod'],
      getSharedSecret: () => 'offline-test',
      random: () => randomValue,
      getConvexClient: (() => ({
        mutation: async (_ref: unknown, _args: unknown, options: unknown) => {
          mutationOptions.push(options);
          if (convexShouldThrow) throw new Error('Simulated delivery outage');
          return convexResponse;
        },
      })) as never,
      createWorkerLogger: (() => ({
        warn: (...args: unknown[]) => logged.warn.push(args),
        error: (...args: unknown[]) => logged.error.push(args),
        info: () => {},
        debug: (...args: unknown[]) => logged.debug.push(args),
      })) as never,
    });
  });

  const job = {
    id: 'check-1',
    data: {
      checkId: 'check-1',
      linkId: baseLink.id,
      convexUrlId: baseLink.convexUrlId,
      longUrl: baseLink.longUrl,
      shortUrl: baseLink.shortUrl,
      environment: 'prod' as const,
      source: 'scheduled' as const,
    },
  };

  test('a failed delivery is retried later with jittered backoff, without the shared mutation queue', async () => {
    check.deliveryAttempts = 4;
    randomValue = 0;
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect(mutationOptions).toEqual([{ skipQueue: true }]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      lastError: 'Simulated delivery outage',
      queueLeaseUntil: null,
    });
    const lowDelay = (updates[0].nextAttemptAt as Date).getTime();
    expect(lowDelay).toBeGreaterThan(now);
    expect(updates[0]).not.toHaveProperty('finishedAt');
    expect(updates[0]).not.toHaveProperty('failedAt');
    expect(logged.error).toHaveLength(0);

    // Higher random value produces a longer jittered delay for the same attempt count.
    updates = [];
    randomValue = 1;
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    const highDelay = (updates[0].nextAttemptAt as Date).getTime();
    expect(highDelay).toBeGreaterThan(lowDelay);
    expect(computeDeliveryRetryDelayMs(5, () => 0)).toBeLessThan(
      computeDeliveryRetryDelayMs(5, () => 1)
    );
  });

  test('the last allowed failed attempt marks the result permanently failed and logs the error', async () => {
    check.deliveryAttempts = MAX_DELIVERY_ATTEMPTS - 1;
    await expect(processJob(job)).rejects.toThrow('Simulated delivery outage');
    expect(updates[0].finishedAt).toBeInstanceOf(Date);
    expect(updates[0].failedAt).toEqual(updates[0].finishedAt);
    expect(logged.error).toHaveLength(1);
    const [fields, message] = logged.error[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(fields).toMatchObject({
      attempts: MAX_DELIVERY_ATTEMPTS,
      reason: 'attempt_limit',
    });
    expect(fields.err).toBeInstanceOf(Error);
    expect(message).toContain('permanently');
  });

  test('a result stored more than 24 hours ago stops retrying after its next failure', async () => {
    Object.assign(check, {
      deliveryAttempts: 2,
      measuredAt: new Date(now - 24 * 60 * 60 * 1000 - 1000),
    });
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
    expect((logged.warn[0][0] as Record<string, unknown>).err).toBeInstanceOf(
      Error
    );
  });

  test('measurement lease contention exits cleanly without corrupting delivery retry state', async () => {
    check.result = null;
    check.measuredAt = null;
    claimLeaseResult = [];

    await expect(processJob(job)).resolves.toBeUndefined();
    expect(checkUrlMock).not.toHaveBeenCalled();
    expect(mutationOptions).toHaveLength(0);
    expect(updates).toHaveLength(0);
    expect(logged.error).toHaveLength(0);
  });

  test('successful delivery skips unnecessary transaction wrapper and reuses measurement returning row', async () => {
    convexShouldThrow = false;
    check.result = null;
    check.measuredAt = null;

    await processJob(job);
    expect(checkUrlMock).toHaveBeenCalledTimes(1);
    expect(mutationOptions).toEqual([{ skipQueue: true }]);
    // 1 transaction for saving measurement + link status; 0 extra transaction for finishing delivery.
    expect(transactionCalls).toBe(1);
    expect(updates[updates.length - 1]).toMatchObject({
      queueLeaseUntil: null,
      lastError: null,
    });
    expect(updates[updates.length - 1].finishedAt).toBeInstanceOf(Date);
  });

  test('url_not_found disables the monitor and finishes the check atomically in a transaction', async () => {
    convexShouldThrow = false;
    convexResponse = { success: false, reason: 'url_not_found' };

    await processJob(job);
    expect(transactionCalls).toBe(1);
    expect(updates).toEqual([
      expect.objectContaining({ isActive: false, isDeleted: true }),
      expect.objectContaining({ queueLeaseUntil: null, lastError: null }),
    ]);
  });
});

describe('worker readiness state tracking', () => {
  const savedWorkerReady = serviceState.workerReady;
  afterEach(() => {
    serviceState.workerReady = savedWorkerReady;
  });

  test('non-blocking error events do not permanently latch workerReady false, and disconnect/recovery transitions cleanly', () => {
    let running = true;
    const workerEmitter = new EventEmitter();
    const workerStub: WorkerLike = {
      isRunning: () => running,
      on: (event, listener) => workerEmitter.on(event, listener),
    };
    const blockingEmitter = new EventEmitter();
    const blockingClient: BlockingClientLike = {
      status: 'ready',
      on: (event, listener) => blockingEmitter.on(event, listener),
    };

    attachWorkerReadiness(workerStub, blockingClient);
    expect(serviceState.workerReady).toBe(true);

    // Transient non-blocking error while worker is running and blocking client is ready: stay ready.
    workerEmitter.emit('error', new Error('Transient lock renewal timeout'));
    expect(serviceState.workerReady).toBe(true);

    // Blocking Redis connection drops: mark not ready.
    blockingClient.status = 'reconnecting';
    blockingEmitter.emit('reconnecting');
    expect(serviceState.workerReady).toBe(false);

    // Blocking connection recovers: ready again.
    blockingClient.status = 'ready';
    blockingEmitter.emit('ready');
    expect(serviceState.workerReady).toBe(true);

    // Even if an error dropped readiness, completing a job while running restores readiness.
    blockingClient.status = 'close';
    blockingEmitter.emit('close');
    expect(serviceState.workerReady).toBe(false);
    blockingClient.status = 'ready';
    workerEmitter.emit('completed');
    expect(serviceState.workerReady).toBe(true);

    // Closing the worker marks it not ready.
    running = false;
    workerEmitter.emit('closing');
    expect(serviceState.workerReady).toBe(false);
  });
});
