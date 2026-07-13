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

# Install only production dependencies (as root so bun can write to /app)
COPY --chown=bun:bun package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

# Copy compiled source + generated Prisma client from builder
COPY --chown=bun:bun --from=builder /app/src ./src
COPY --chown=bun:bun --from=builder /app/prisma ./prisma
COPY --chown=bun:bun tsconfig.json prisma.config.ts ./

# Drop privileges: the official oven/bun:1.3-alpine image ships with a non-root
# 'bun' user (uid 1000). Running as root in a container handling regulated-sector
# data exceeds the risk floor — switch before the process starts.
USER bun

# Run migrations then start the server.
# The CMD is intentionally a shell form so the entrypoint can be overridden
# (e.g. compose `command:` can substitute the healthcheck or a one-off migration).
EXPOSE 8081

# DATA-RESIDENCY: this image is deployed to Railway EU region only (europe-west4,
# see railway.json). Request/response bodies are NEVER logged — hono/logger
# emits method+path+status only. Notification title/body may name clients/
# estimates — do NOT add any logger that includes request bodies or the Prisma
# 'query' log level.
#
# SINGLE-INSTANCE ONLY (specs/005-notification-center plan.md Risk R2):
# railway.json pins numReplicas: 1 — the in-process EventBus fan-out and the
# in-process stream-ticket store are correct for exactly one running instance.
# Do NOT enable autoscale / multiple replicas for this service without first
# moving both seams onto Postgres LISTEN/NOTIFY + a shared ticket table (the
# interfaces are designed for that migration, see notify-api/src/notifications).
CMD ["bun", "run", "src/index.ts"]
