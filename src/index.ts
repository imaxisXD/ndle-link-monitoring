import * as Sentry from '@sentry/bun';
import { logger } from './lib/logger';
import { validateConfiguration, enabledEnvironments } from './lib/config';
import { serviceState } from './lib/service-state';

const runScheduler = process.env.RUN_SCHEDULER !== 'false';
const runWorker = process.env.RUN_WORKER !== 'false';
Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
validateConfiguration(runWorker);
const { createApp } = await import('./app');
const { getQueue, closeAllConnections } = await import('./queue/factory');
const { db } = await import('./db');
const { sql } = await import('drizzle-orm');
const scheduler = await import('./scheduler');
const worker = await import('./worker');
const { getConvexClient } = await import('./lib/convex');

await db.execute(sql`select 1`);
await getQueue().waitUntilReady();
if (runWorker) {
  for (const environment of enabledEnvironments()) getConvexClient(environment);
  await worker.startWorker();
}
if (runScheduler) await scheduler.startScheduler();
serviceState.started = true;
const app = createApp(runScheduler, runWorker).listen(Number(process.env.PORT || 3001));
logger.info({ port: app.server?.port }, 'Monitor service ready');

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  serviceState.stopping = true;
  await app.stop();
  await scheduler.stopScheduler();
  await worker.shutdownWorker();
  await closeAllConnections();
  process.exit(0);
}
process.on('SIGTERM', () => { shutdown().catch(error => { logger.error({ error }, 'Shutdown failed'); process.exit(1); }); });
process.on('SIGINT', () => { shutdown().catch(error => { logger.error({ error }, 'Shutdown failed'); process.exit(1); }); });
process.on('uncaughtException', error => { Sentry.captureException(error); logger.fatal({ error }, 'Monitor service stopped unexpectedly'); process.exit(1); });
process.on('unhandledRejection', error => { Sentry.captureException(error); logger.fatal({ error }, 'Monitor service stopped unexpectedly'); process.exit(1); });
