import { Elysia, t } from 'elysia';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from './db';
import { monitorChecks, monitoredLinks } from './db/schema';
import { getQueue } from './queue/factory';
import { InvalidUrlError, validateRegistrationUrl } from './lib/url-safety';
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

// Callers treat `invalid_url` as permanent and stop retrying. Other failures stay server errors.
function normalizeLongUrl(longUrl: string) {
  try {
    return { success: true as const, longUrl: validateRegistrationUrl(longUrl).toString() };
  } catch (error) {
    if (!(error instanceof InvalidUrlError)) throw error;
    return { success: false as const, code: 'invalid_url' as const, error: error.message };
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Hashing gives both sides the same length, so the comparison time does not reveal the secret.
export function hasValidBearerToken(authorization: string | null, secret: string): boolean {
  return timingSafeEqual(sha256(authorization ?? ''), sha256(`Bearer ${secret}`));
}

function authenticate(request: Request): 'allowed' | 'denied' | 'unconfigured' {
  const secret = process.env.MONITORING_API_SECRET;
  if (!secret) return 'unconfigured';
  return hasValidBearerToken(request.headers.get('authorization'), secret) ? 'allowed' : 'denied';
}

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
      // Authentication runs before parsing and validation, so callers without the secret never
      // see schema details. Elysia's beforeHandle runs after validation.
      // An unauthenticated body is not read; the transform hook then rejects the request.
      .onParse(({ request }) => authenticate(request) === 'allowed' ? undefined : {})
      .onTransform(({ request, status }) => {
        const access = authenticate(request);
        if (access === 'unconfigured') throw status(503, { error: 'Service is not configured' });
        if (access === 'denied') throw status(401, { error: 'Access denied' });
      })
      .post('/register', async ({ body, set }) => {
        const url = normalizeLongUrl(body.longUrl);
        if (!url.success) { set.status = 400; return url; }
        const row = await registerMonitor({ ...body, longUrl: url.longUrl, environment: body.environment ?? 'prod' });
        if (!row) throw new Error('Monitoring registration was not saved');
        return { success: true, linkId: row.id, monitoringVersion: row.monitoringVersion, isDeleted: row.isDeleted };
      }, { body: t.Object({ ...registrationSchema.properties, environment: environmentSchema }) })
      .post('/batch', async ({ body }) => {
        const environment = body.environment ?? 'prod';
        // Invalid URLs are reported per link so they do not block the rest of the batch.
        const checked = body.links.map(link => ({ link, url: normalizeLongUrl(link.longUrl) }));
        let inserted = 0;
        for (const { link, url } of checked) {
          if (!url.success) continue;
          await registerMonitor({ ...link, environment, longUrl: url.longUrl });
          inserted++;
        }
        return {
          success: true, inserted, rejected: checked.length - inserted,
          results: checked.map(({ link, url }) => url.success ? { convexUrlId: link.convexUrlId, success: true } : { convexUrlId: link.convexUrlId, ...url }),
        };
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
