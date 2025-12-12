import { Elysia, t } from 'elysia';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { monitoredLinks, NewMonitoredLink } from './db/schema';
import { createQueue } from './queue/factory';
import { logger, createRequestLogger } from './lib/logger';
import { DEFAULT_INTERVAL_MS } from './lib/constants';

const PORT = parseInt(process.env.PORT || '3001');

// Determine which components to run based on environment
const RUN_SCHEDULER = process.env.RUN_SCHEDULER !== 'false';
const RUN_WORKER = process.env.RUN_WORKER !== 'false';

const app = new Elysia()
  // Request ID middleware
  .derive(({ request }) => {
    const requestId =
      request.headers.get('x-request-id') || randomUUID().slice(0, 8);
    return {
      requestId,
      log: createRequestLogger(requestId),
    };
  })
  .get('/', () => {
    (logger.info({
      status: 'ok',
      service: 'link-monitoring',
      timestamp: new Date().toISOString(),
    }),
      {
        status: 'ok',
        service: 'link-monitoring',
        timestamp: new Date().toISOString(),
      });
  })
  // Health check (public)
  .get(
    '/health',
    () => (
      logger.info({
        status: 'ok',
        service: 'link-monitoring',
        timestamp: new Date().toISOString(),
      }),
      {
        status: 'ok',
        service: 'link-monitoring',
        timestamp: new Date().toISOString(),
      }
    )
  )
  // Auth guard for all /monitors routes
  .group('/monitors', app =>
    app
      .onBeforeHandle(({ request, set, log }) => {
        const secret = process.env.MONITORING_API_SECRET;
        const auth = request.headers.get('authorization');

        if (!secret) {
          log.warn('MONITORING_API_SECRET not set - allowing request (DEV)');
          return; // Allow in dev
        }

        if (auth !== `Bearer ${secret}`) {
          set.status = 401;
          return { error: 'Unauthorized' };
        }
      })

      // POST /monitors/register - Auto-called by Convex on URL creation
      .post(
        '/register',
        async ({ body, log }) => {
          log.info(
            { shortUrl: body.shortUrl, environment: body.environment },
            'Registering new link'
          );

          const newLink: NewMonitoredLink = {
            convexUrlId: body.convexUrlId,
            convexUserId: body.convexUserId,
            longUrl: body.longUrl,
            shortUrl: body.shortUrl,
            environment: body.environment || 'prod',
            intervalMs: body.intervalMs || DEFAULT_INTERVAL_MS,
            nextCheckAt: new Date(), // Check immediately
            isActive: true,
          };

          const [inserted] = await db
            .insert(monitoredLinks)
            .values(newLink)
            .onConflictDoNothing() // Idempotent
            .returning();

          if (!inserted) {
            log.warn('Link already registered or conflict');
            return { success: true, message: 'Already registered' };
          }

          log.info({ linkId: inserted.id }, 'Link registered');
          return { success: true, linkId: inserted.id };
        },
        {
          body: t.Object({
            convexUrlId: t.String(),
            convexUserId: t.String(),
            longUrl: t.String(),
            shortUrl: t.String(),
            environment: t.Optional(
              t.Union([t.Literal('dev'), t.Literal('prod')])
            ),
            intervalMs: t.Optional(t.Number()),
          }),
        }
      )

      // POST /monitors/batch - Bulk import existing links
      .post(
        '/batch',
        async ({ body, log }) => {
          log.info(
            { count: body.links.length, environment: body.environment },
            'Batch registering links'
          );

          const links: NewMonitoredLink[] = body.links.map(link => ({
            convexUrlId: link.convexUrlId,
            convexUserId: link.convexUserId,
            longUrl: link.longUrl,
            shortUrl: link.shortUrl,
            environment: body.environment || 'prod',
            intervalMs: link.intervalMs || DEFAULT_INTERVAL_MS,
            nextCheckAt: new Date(),
            isActive: true,
          }));

          const result = await db
            .insert(monitoredLinks)
            .values(links)
            .onConflictDoNothing()
            .returning({ id: monitoredLinks.id });

          log.info({ inserted: result.length }, 'Batch registration complete');
          return { success: true, inserted: result.length };
        },
        {
          body: t.Object({
            environment: t.Optional(
              t.Union([t.Literal('dev'), t.Literal('prod')])
            ),
            links: t.Array(
              t.Object({
                convexUrlId: t.String(),
                convexUserId: t.String(),
                longUrl: t.String(),
                shortUrl: t.String(),
                intervalMs: t.Optional(t.Number()),
              })
            ),
          }),
        }
      )

      // POST /monitors/:id/force-check - Immediate check
      .post(
        '/:id/force-check',
        async ({ params, log, set }) => {
          const link = await db.query.monitoredLinks.findFirst({
            where: eq(monitoredLinks.id, params.id),
          });

          if (!link) {
            set.status = 404;
            return { error: 'Link not found' };
          }

          const queue = createQueue();
          await queue.add(
            `force-${link.id}`,
            {
              linkId: link.id,
              convexUrlId: link.convexUrlId,
              convexUserId: link.convexUserId,
              longUrl: link.longUrl,
              shortUrl: link.shortUrl,
              environment: link.environment as 'dev' | 'prod',
            },
            {
              priority: 1, // High priority
            }
          );
          await queue.close();

          log.info({ linkId: link.id }, 'Force check queued');
          return { success: true, message: 'Check queued' };
        },
        {
          params: t.Object({ id: t.String() }),
        }
      )

      // GET /monitors/:id - Get link status
      .get(
        '/:id',
        async ({ params, set }) => {
          const link = await db.query.monitoredLinks.findFirst({
            where: eq(monitoredLinks.id, params.id),
          });

          if (!link) {
            set.status = 404;
            return { error: 'Link not found' };
          }

          return {
            success: true,
            data: {
              id: link.id,
              shortUrl: link.shortUrl,
              longUrl: link.longUrl,
              currentStatus: link.currentStatus,
              lastCheckedAt: link.lastCheckedAt,
              lastStatusCode: link.lastStatusCode,
              lastLatencyMs: link.lastLatencyMs,
              consecutiveFailures: link.consecutiveFailures,
              intervalMs: link.intervalMs,
              isActive: link.isActive,
            },
          };
        },
        {
          params: t.Object({ id: t.String() }),
        }
      )

      // DELETE /monitors/:id - Disable monitoring
      .delete(
        '/:id',
        async ({ params, log }) => {
          await db
            .update(monitoredLinks)
            .set({ isActive: false, updatedAt: new Date() })
            .where(eq(monitoredLinks.id, params.id));

          log.info({ linkId: params.id }, 'Monitoring disabled');
          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
        }
      )
  )
  .listen(PORT);

logger.info({ port: PORT }, '🦊 Elysia API server started');

// Conditionally start scheduler (uses dynamic import to avoid side effects)
if (RUN_SCHEDULER) {
  import('./scheduler').then(({ startScheduler }) => {
    startScheduler();
  });
}

// Conditionally start worker (uses dynamic import to avoid auto-start on import)
let workerModule: typeof import('./worker') | null = null;

if (RUN_WORKER) {
  import('./worker').then(mod => {
    workerModule = mod;
    mod.startWorker(); // Explicitly start the worker
  });
}

// Graceful shutdown
async function shutdown() {
  logger.info('Received shutdown signal');

  // Stop scheduler
  if (RUN_SCHEDULER) {
    const { stopScheduler } = await import('./scheduler');
    stopScheduler();
  }

  // Stop worker
  if (workerModule) {
    await workerModule.shutdownWorker();
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
