FROM oven/bun:1.4.4-debian

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=3001

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --chown=bun:bun drizzle ./drizzle
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun tsconfig.json ./

USER bun

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/ready'); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }"

CMD ["sh", "-c", "bun run db:migrate && exec bun run src/index.ts"]
