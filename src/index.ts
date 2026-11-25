import * as Sentry from '@sentry/bun';
import { logger } from './lib/logger';
import { validateConfiguration, enabledEnvironments } from './lib/config';
import { parsePositiveIntEnv } from './lib/constants';
import { serviceState } from './lib/service-state';

const SHUTDOWN_TIMEOUT_MS = 15_000;
const SENTRY_FLUSH_TIMEOUT_MS = 2_000;

Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });

let fatalInProgress = false;
async function handleFatal(error: unknown): Promise<void> {
  if (fatalInProgress) return;
  fatalInProgress = true;
  Sentry.captureException(error);
  logger.fatal({ err: error }, 'Monitor service stopped unexpectedly');
  await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(() => {});
  process.exit(1);
}

process.on('uncaughtException', error => {
  void handleFatal(error);
});
process.on('unhandledRejection', error => {
  void handleFatal(error);
});

let stopping = false;
let stopApp: (() => Promise<unknown>) | null = null;
let stopScheduler: (() => Promise<void>) | null = null;
let shutdownWorker: (() => Promise<void>) | null = null;
let stopServerAddressRefresh: (() => void) | null = null;
let closeRedisConnections: (() => Promise<void>) | null = null;
let closeDatabase: (() => Promise<void>) | null = null;

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  serviceState.stopping = true;

  const watchdog = setTimeout(() => {
    logger.fatal('Graceful shutdown timed out; forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  watchdog.unref();

  try {
    await stopApp?.();
    await stopScheduler?.();
    await shutdownWorker?.();
    stopServerAddressRefresh?.();
    await closeRedisConnections?.();
    await closeDatabase?.();
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(() => {});
    clearTimeout(watchdog);
    process.exit(0);
  } catch (error) {
    clearTimeout(watchdog);
    logger.error({ err: error }, 'Shutdown failed');
    Sentry.captureException(error);
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS).catch(() => {});
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown();
});
process.on('SIGINT', () => {
  void shutdown();
});

const runScheduler = process.env.RUN_SCHEDULER !== 'false';
const runWorker = process.env.RUN_WORKER !== 'false';

validateConfiguration(runWorker);
const port = parsePositiveIntEnv('PORT', 3001, 65535);

const { createApp } = await import('./app');
const { getQueue, closeAllConnections } = await import('./queue/factory');
const { db, closeDatabase: closeDb } = await import('./db');
const { sql } = await import('drizzle-orm');
const scheduler = await import('./scheduler');
const worker = await import('./worker');
const { getConvexClient } = await import('./lib/convex');
const serverAddresses = await import('./lib/server-addresses');

closeRedisConnections = closeAllConnections;
closeDatabase = closeDb;
stopScheduler = scheduler.stopScheduler;
shutdownWorker = worker.shutdownWorker;
stopServerAddressRefresh = serverAddresses.stopServerAddressRefresh;

await db.execute(sql`select 1`);
await getQueue().waitUntilReady();

if (runWorker) {
  for (const environment of enabledEnvironments()) {
    getConvexClient(environment);
  }
  // Learn this server's public addresses before the first check, so checks never request it.
  await serverAddresses.startServerAddressRefresh();
  await worker.startWorker();
}
if (runScheduler) await scheduler.startScheduler();

serviceState.started = true;
const app = createApp(runScheduler, runWorker).listen(port);
stopApp = () => app.stop();
logger.info({ port: app.server?.port }, 'Monitor service ready');
