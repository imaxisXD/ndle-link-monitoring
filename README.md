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

Fill in `DATABASE_URL`, `REDIS_URL`, `CONVEX_URL_DEV`, `CONVEX_URL_PROD`,
`MONITORING_API_SECRET`, and `MONITORING_SHARED_SECRET`. Both Convex URLs are
required when the worker runs because it creates both clients at startup. Sentry
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
