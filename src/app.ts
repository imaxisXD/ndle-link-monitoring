import { Elysia, t } from 'elysia';
import * as Sentry from '@sentry/bun';
import { createHash, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from './db';
import { getQueue } from './queue/factory';
import { InvalidUrlError, validateRegistrationUrl } from './lib/url-safety';
import {
  registerMonitor as defaultRegisterMonitor,
  unregisterMonitor as defaultUnregisterMonitor,
} from './lib/monitor-store';
import { componentsReady } from './lib/service-state';
import { withTimeout } from './lib/timeout';
import { logger as defaultLogger } from './lib/logger';

const READY_CHECK_TIMEOUT_MS = 2_000;
const READY_CACHE_TTL_MS = 2_000;

const environmentSchema = t.Optional(
  t.Union([t.Literal('dev'), t.Literal('prod')])
);
const versionSchema = t.Optional(
  t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
);
const registrationSchema = t.Object({
  convexUrlId: t.String({ minLength: 1 }),
  convexUserId: t.String({ minLength: 1 }),
  longUrl: t.String({ maxLength: 8192 }),
  shortUrl: t.String(),
  intervalMs: t.Optional(t.Integer({ minimum: 1, maximum: 2147483647 })),
  monitoringVersion: versionSchema,
  environment: environmentSchema,
});

// Callers treat `invalid_url` as permanent and stop retrying. Other failures stay server errors.
function normalizeLongUrl(longUrl: string) {
  try {
    return {
      success: true as const,
      longUrl: validateRegistrationUrl(longUrl).toString(),
    };
  } catch (error) {
    if (!(error instanceof InvalidUrlError)) throw error;
    return {
      success: false as const,
      code: 'invalid_url' as const,
      error: error.message,
    };
  }
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

// Hashing gives both sides the same length, so the comparison time does not reveal the secret.
export function hasValidBearerToken(
  authorization: string | null,
  secret: string
): boolean {
  return timingSafeEqual(
    sha256(authorization ?? ''),
    sha256(`Bearer ${secret}`)
  );
}

function authenticate(request: Request): 'allowed' | 'denied' | 'unconfigured' {
  const secret = process.env.MONITORING_API_SECRET;
  if (!secret) return 'unconfigured';
  return hasValidBearerToken(request.headers.get('authorization'), secret)
    ? 'allowed'
    : 'denied';
}

export interface AppDependencies {
  registerMonitor: typeof defaultRegisterMonitor;
  unregisterMonitor: typeof defaultUnregisterMonitor;
  checkDependencies: () => Promise<void>;
  logger: Pick<typeof defaultLogger, 'error'>;
  captureException: (error: unknown) => void;
  now: () => number;
}

async function defaultCheckDependencies(): Promise<void> {
  await Promise.all([
    db.execute(sql`select 1`),
    getQueue().client.then(client =>
      (client as unknown as { ping(): Promise<string> }).ping()
    ),
  ]);
}

export function createApp(
  runScheduler: boolean,
  runWorker: boolean,
  overrides: Partial<AppDependencies> = {}
) {
  const deps: AppDependencies = {
    registerMonitor: defaultRegisterMonitor,
    unregisterMonitor: defaultUnregisterMonitor,
    checkDependencies: defaultCheckDependencies,
    logger: defaultLogger,
    captureException: error => {
      Sentry.captureException(error);
    },
    now: Date.now,
    ...overrides,
  };

  let readyCache: { ok: boolean; expiresAt: number } | null = null;
  let readyInFlight: Promise<boolean> | null = null;

  async function checkReadinessDependencies(): Promise<boolean> {
    const current = deps.now();
    if (readyCache && current < readyCache.expiresAt) {
      return readyCache.ok;
    }
    if (!readyInFlight) {
      readyInFlight = withTimeout(
        deps.checkDependencies(),
        READY_CHECK_TIMEOUT_MS,
        'Readiness check timed out'
      )
        .then(() => true)
        .catch(() => false)
        .then(ok => {
          readyCache = { ok, expiresAt: deps.now() + READY_CACHE_TTL_MS };
          return ok;
        })
        .finally(() => {
          readyInFlight = null;
        });
    }
    return readyInFlight;
  }

  return new Elysia()
    .onError(({ code, error, set, request }) => {
      if (
        code === 'VALIDATION' ||
        code === 'NOT_FOUND' ||
        code === 'PARSE' ||
        code === 'INVALID_FILE_TYPE' ||
        typeof code === 'number' ||
        (typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          'response' in error)
      ) {
        return;
      }
      let pathname = request.url;
      try {
        pathname = new URL(request.url).pathname;
      } catch {
        // Keep raw URL string when parsing fails
      }
      deps.logger.error(
        { err: error, code, method: request.method, path: pathname },
        'Unhandled HTTP error'
      );
      deps.captureException(error);
      set.status = 500;
      return { error: 'Internal server error' };
    })
    .get('/', () => ({ status: 'ok', service: 'link-monitoring' }))
    .get('/health', () => ({ status: 'ok', service: 'link-monitoring' }))
    .get('/ready', async ({ set }) => {
      if (!componentsReady(runScheduler, runWorker, deps.now())) {
        set.status = 503;
        return { status: 'not ready' };
      }
      const ok = await checkReadinessDependencies();
      if (!ok) {
        set.status = 503;
        return { status: 'not ready' };
      }
      return { status: 'ready' };
    })
    .group('/monitors', group =>
      group
        // Authentication runs before parsing and validation, so callers without the secret never
        // see schema details. Elysia's beforeHandle runs after validation.
        // An unauthenticated body is not read; the transform hook then rejects the request.
        .onParse(({ request }) =>
          authenticate(request) === 'allowed' ? undefined : {}
        )
        .onTransform(({ request, status }) => {
          const access = authenticate(request);
          if (access === 'unconfigured') {
            throw status(503, { error: 'Service is not configured' });
          }
          if (access === 'denied') {
            throw status(401, { error: 'Access denied' });
          }
        })
        .post(
          '/register',
          async ({ body, set }) => {
            const url = normalizeLongUrl(body.longUrl);
            if (!url.success) {
              set.status = 400;
              return url;
            }
            const row = await deps.registerMonitor({
              ...body,
              longUrl: url.longUrl,
              environment: body.environment ?? 'prod',
            });
            if (!row) throw new Error('Monitoring registration was not saved');
            return {
              success: true,
              linkId: row.id,
              monitoringVersion: row.monitoringVersion,
              isDeleted: row.isDeleted,
            };
          },
          { body: registrationSchema }
        )
        .post(
          '/unregister',
          async ({ body }) => {
            const row = await deps.unregisterMonitor(
              body.convexUrlId,
              body.environment ?? 'prod',
              body.monitoringVersion
            );
            if (!row) throw new Error('Monitoring deletion was not saved');
            return {
              success: true,
              disabledCount: row.isDeleted ? 1 : 0,
              monitoringVersion: row.monitoringVersion,
              isDeleted: row.isDeleted,
            };
          },
          {
            body: t.Object({
              convexUrlId: t.String({ minLength: 1 }),
              environment: environmentSchema,
              monitoringVersion: versionSchema,
            }),
          }
        )
    );
}
