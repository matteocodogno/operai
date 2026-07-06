# ─── Build stage ─────────────────────────────────────────────────────────────
# Generates the Prisma client inside the container so the native query-engine
# binary matches the Linux target (not the developer's macOS build).
FROM oven/bun:1.3-alpine AS builder

WORKDIR /app

# Install dependencies (exact lockfile, production + dev needed for prisma generate)
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Copy source + Prisma schema
COPY tsconfig.json prisma.config.ts ./
COPY prisma ./prisma
COPY src ./src

# Generate Prisma client for the linux/alpine target
RUN bun run node_modules/prisma/build/index.js generate

# ─── Production stage ─────────────────────────────────────────────────────────
FROM oven/bun:1.3-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install only production dependencies
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# Copy compiled source + generated Prisma client from builder
COPY --from=builder /app/src ./src
COPY --from=builder /app/prisma ./prisma
COPY tsconfig.json prisma.config.ts ./

# Run migrations then start the server.
# The CMD is intentionally a shell form so the entrypoint can be overridden
# (e.g. compose `command:` can substitute the healthcheck or a one-off migration).
EXPOSE 8080

# DATA-RESIDENCY: this image is deployed to Railway EU region only.
# Request/response bodies are NEVER logged — hono/logger emits method+path+status only.
# Do NOT add any logger that includes request bodies or the Prisma 'query' log level.
CMD ["bun", "run", "src/index.ts"]
