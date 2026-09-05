# NDLE link monitoring

Bun service that checks saved links. Elysia exposes the monitor API, PostgreSQL
stores monitor schedules and recent status, BullMQ uses Redis for check jobs, and
Convex receives health-check results.

## Local setup

Install Bun and provide development PostgreSQL, Redis, and Convex instances.

```sh
bun install
cp .env.example .env
```

Fill in `DATABASE_URL`, `REDIS_URL`, the selected `CONVEX_URL_PROD` or `CONVEX_URL_DEV`,
`MONITORING_API_SECRET`, and `MONITORING_SHARED_SECRET`. Configure only the Convex URLs selected by `MONITORING_ENVIRONMENTS` (production by default). Sentry
is optional.

Apply migrations to your development database, then start the service:

```sh
bun run db:migrate
bun run dev
```

The API listens on port 3001 by default. Reuse an existing server for this
repository. `RUN_SCHEDULER=false` and `RUN_WORKER=false` disable those background
components; the API always runs.

Continuous monitoring runs only for production links, at intervals of at least
30 minutes. Manual checks remain available for development links.

## Checks

```sh
bun test
bun node_modules/typescript/bin/tsc --noEmit
```

The policy tests run locally without connecting to Redis, PostgreSQL, or Convex.

## Operations

`GET /health` reports that the API process is running. Routes under `/monitors`
require the bearer token from `MONITORING_API_SECRET`. The API supports registering
links, batch registration, disabling monitors, reading status, and manual checks.

`bun run start` applies database migrations before starting the API and enabled
background components. `bun run db:generate` creates migrations after schema
changes; `bun run db:migrate` applies them. These commands use the configured
database, so choose the intended environment before running them.

## Reliable delivery and rollout

Migration `0004_reliable_monitoring.sql` adds durable check records and monitor
versions. PostgreSQL now records each due check in the same transaction that
advances its schedule. Redis receives a stable check ID. If Redis is unavailable,
unfinished database rows are dispatched after it recovers. A destination is
measured once after a result has been saved; delivery failures retry that saved
result with a delay of up to five minutes. Completed rows are retained for 35 days.
A crash before a measurement is saved can repeat the destination request.

Deploy the additive Convex schema and result handler before this service. The new
handler accepts old jobs, rejects duplicate check IDs, includes late samples in
their daily totals, and preserves the latest status. It ignores samples older
than the 35-day receipt window. Then apply this service migration and release the
service. Old and new jobs can share Redis during the rollout. Do not roll back to
the old scheduler while unfinished checks exist: it does not understand the
new durable queue. Database migrations run before the service starts; no database
migration or deployment has been performed by editing these files.

Registration and unregistration accept `monitoringVersion`, an increasing integer
owned by Convex's durable synchronization job. An older version is ignored.
Deletion wins equal versions and keeps a tombstone even when registration has
not arrived yet. Equal registration deliveries do not reset the due time.
Versionless callers use version zero and cannot overwrite versioned changes.

Set `MONITORING_ENVIRONMENTS=prod` for production-only workers. Add `dev` only on
workers that need manual development checks, and configure the matching Convex
URL. Production workers no longer require a development Convex URL. At least one
instance must run the scheduler: it also dispatches manual checks and pending
result deliveries. Multiple schedulers use database row claims and may safely
run together. Each worker rechecks current activation/version before delivery.

`GET /health` reports only process liveness. `GET /ready` returns 503 if startup
is incomplete, a required component is unavailable, the scheduler has not
succeeded for a minute, or PostgreSQL/Redis do not answer. The Docker health check
uses readiness. Startup validates configuration and required connections before
opening the API port. Track overdue links and the age of unfinished
`monitor_checks` rows in operational alerts; process uptime alone is insufficient.

A blocked HTTP 403 check is `unknown`, rather than a confirmed healthy link.
Unknown checks are excluded from the uptime denominator. The frontend separates
pending, unknown and overdue checks from current results. Outbound requests pin
DNS-validated addresses, validate every redirect, reject private/reserved address
ranges, and stop after response headers instead of downloading the response body.

## Integration verification

`bun test` runs offline tests and skips database tests unless the explicit test
variables below are set. Integration tests require a dedicated local PostgreSQL
database named `monitoring_test` and a dedicated local Redis database 15. They
clear those test records; never point them at shared services. CI provisions fresh
PostgreSQL/Redis services, applies migrations, typechecks, and runs these tests.

```sh
MONITOR_TEST_DATABASE_URL=postgres://postgres:password@127.0.0.1:5432/monitoring_test \
MONITOR_TEST_REDIS_URL=redis://127.0.0.1:6379/15 bun --no-env-file test
```

Register and unregister acknowledgements include `success`, the stored
`monitoringVersion`, and `isDeleted`. Convex only completes its delivery when this
receipt confirms the requested state or a newer version. During the Convex-first
rollout, an older monitoring service response leaves the job pending; upgrading
this service lets the same job complete on retry.
