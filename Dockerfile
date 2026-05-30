FROM oven/bun:1-debian

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY drizzle ./drizzle
COPY src ./src
COPY drizzle.config.ts tsconfig.json ./

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD bun -e "try { const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health'); process.exit(r.ok ? 0 : 1); } catch { process.exit(1); }"

CMD ["bun", "run", "start"]
