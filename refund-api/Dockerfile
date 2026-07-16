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
# financial/PII data (expense amounts, receipt attachments) exceeds the risk
# floor — switch before the process starts.
USER bun

EXPOSE 8082

# DATA-RESIDENCY (T19, specs/007-refund-service): this image is deployed to
# Railway EU region only (europe-west4, see railway.json) — refund-api handles
# financial figures and receipt-attachment metadata that may carry PII (names,
# addresses, partial card numbers per docs/adr/0016). Request/response bodies
# are NEVER logged — hono/logger emits method+path+status only (src/index.ts /
# src/lib/logger.ts). Do NOT add any logger that includes body, query
# parameters with content, or the Prisma 'query' log level. Object storage
# (REFUND_S3_*, ADR-0016) is a SEPARATE EU-region resource — receipt bytes
# never transit this container (presigned direct-to-bucket upload/download).
#
# The CMD is intentionally a shell form so the entrypoint can be overridden
# (e.g. compose `command:` can substitute the healthcheck or a one-off migration).
CMD ["bun", "run", "src/index.ts"]
