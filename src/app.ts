import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { monitorChecks, monitoredLinks } from './db/schema';
import { getQueue } from './queue/factory';
import { assertSafeHttpUrl } from './lib/url-safety';
import { registerMonitor, unregisterMonitor } from './lib/monitor-store';
import { componentsReady } from './lib/service-state';
import { enabledEnvironments } from './lib/config';

const environmentSchema = t.Optional(t.Union([t.Literal('dev'), t.Literal('prod')]));
const versionSchema = t.Optional(t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const registrationSchema = t.Object({
  convexUrlId: t.String({ minLength: 1 }), convexUserId: t.String({ minLength: 1 }),
  longUrl: t.String({ maxLength: 8192 }), shortUrl: t.String(),
  intervalMs: t.Optional(t.Integer({ minimum: 1, maximum: 2147483647 })),
  monitoringVersion: versionSchema,
});

export function createApp(runScheduler: boolean, runWorker: boolean) {
  return new Elysia()
    .get('/', () => ({ status: 'ok', service: 'link-monitoring' }))
    .get('/health', () => ({ status: 'ok', service: 'link-monitoring' }))
    .get('/ready', async ({ set }) => {
      if (!componentsReady(runScheduler, runWorker)) {
        set.status = 503;
        return { status: 'not ready' };
      }
      try {
        await Promise.race([
          Promise.all([db.execute(sql`select 1`), getQueue().getJobCounts('waiting', 'active', 'failed')]),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Readiness check timed out')), 2000)),
        ]);
        return { status: 'ready' };
      } catch {
        set.status = 503;
        return { status: 'not ready' };
      }
    })
    .group('/monitors', group => group
      .onBeforeHandle(({ request, set }) => {
        const secret = process.env.MONITORING_API_SECRET;
        if (!secret) { set.status = 503; return { error: 'Service is not configured' }; }
        if (request.headers.get('authorization') !== `Bearer ${secret}`) {
          set.status = 401; return { error: 'Access denied' };
        }
      })
      .post('/register', async ({ body, set }) => {
        try {
          const longUrl = (await assertSafeHttpUrl(body.longUrl)).toString();
          const row = await registerMonitor({ ...body, longUrl, environment: body.environment ?? 'prod' });
          if (!row) throw new Error('Monitoring registration was not saved');
          return { success: true, linkId: row.id, monitoringVersion: row.monitoringVersion, isDeleted: row.isDeleted };
        } catch (error) {
          if (error instanceof TypeError || (error instanceof Error && /URL|hostname|private network|Localhost/.test(error.message))) {
            set.status = 400; return { success: false, error: error instanceof Error ? error.message : 'Invalid URL' };
          }
          throw error;
        }
      }, { body: t.Object({ ...registrationSchema.properties, environment: environmentSchema }) })
      .post('/batch', async ({ body, set }) => {
        const environment = body.environment ?? 'prod';
        const links = [];
        try {
          for (const link of body.links) links.push({ ...link, environment, longUrl: (await assertSafeHttpUrl(link.longUrl)).toString() });
        } catch (error) {
          set.status = 400;
          return { success: false, error: error instanceof Error ? error.message : 'Invalid URL' };
        }
        for (const link of links) await registerMonitor(link);
        return { success: true, inserted: links.length };
      }, { body: t.Object({ environment: environmentSchema, links: t.Array(registrationSchema, { maxItems: 100 }) }) })
      .post('/unregister', async ({ body }) => {
        const row = await unregisterMonitor(body.convexUrlId, body.environment ?? 'prod', body.monitoringVersion);
        if (!row) throw new Error('Monitoring deletion was not saved');
        return { success: true, disabledCount: row.isDeleted ? 1 : 0, monitoringVersion: row.monitoringVersion, isDeleted: row.isDeleted };
      }, { body: t.Object({ convexUrlId: t.String(), environment: environmentSchema, monitoringVersion: versionSchema }) })
      .post('/:id/force-check', async ({ params, set }) => {
        const link = await db.query.monitoredLinks.findFirst({ where: eq(monitoredLinks.id, params.id) });
        if (!link || link.isDeleted) { set.status = 404; return { error: 'Link not found' }; }
        if (!enabledEnvironments().includes(link.environment)) { set.status = 409; return { error: 'Checks for this environment are not enabled' }; }
        const checkId = `manual-${randomUUID()}`;
        await db.insert(monitorChecks).values({ id: checkId, linkId: link.id, monitoringVersion: link.monitoringVersion, source: 'manual', scheduledAt: new Date() });
        return { success: true, checkId, message: 'Check queued' };
      }, { params: t.Object({ id: t.String({ format: 'uuid' }) }) })
      .get('/:id', async ({ params, set }) => {
        const link = await db.query.monitoredLinks.findFirst({ where: eq(monitoredLinks.id, params.id) });
        if (!link || link.isDeleted) { set.status = 404; return { error: 'Link not found' }; }
        return { success: true, data: link };
      }, { params: t.Object({ id: t.String({ format: 'uuid' }) }) })
      .delete('/:id', async ({ params }) => {
        const link = await db.query.monitoredLinks.findFirst({ where: eq(monitoredLinks.id, params.id) });
        if (link) await unregisterMonitor(link.convexUrlId, link.environment, link.monitoringVersion);
        return { success: true };
      }, { params: t.Object({ id: t.String({ format: 'uuid' }) }) })
    );
}
